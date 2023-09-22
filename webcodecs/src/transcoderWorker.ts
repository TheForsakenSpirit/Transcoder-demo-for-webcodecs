import mp4box, { DataStream } from 'mp4box';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
// import { sendMessage } from './worker';

const targetWidth = 480;
const targetHeight = 640;
const targetCodec = 'avc1.42001e'; //h264 https://www.w3.org/TR/webcodecs-codec-registry/#video-codec-registry

//https://github.com/w3c/webcodecs/blob/6fc8007a90ce0d6493a602a8fa08269eba6aa553/samples/audio-video-player/mp4_pull_demuxer.js#L50
const getDescription = (file: mp4box.MP4File) => {
  const entry = file.moov.traks[0].mdia.minf.stbl.stsd.entries[0];

  const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
  if (!box) {
    throw new Error('avcC, hvcC, vpcC, or av1C box not found!');
  }
  return box;
};

const transformDescription = (descriptionBox: mp4box.MP4Box) => {
  const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
  descriptionBox.write(stream);
  return new Uint8Array(stream.buffer, 8);
};

//TODO: handle abort controller
export const transcode = async (buffer: ArrayBufferLike): Promise<ArrayBuffer> => {
  console.time('transcode-t');
  const mp4boxFile = mp4box.createFile();
  console.log('----', buffer);
  const info = await demux(mp4boxFile, buffer);
  console.log('info', info);
  console.log('mp4boxFile', mp4boxFile);
  const videoTrack = getVideoTrackInfo(info);
  console.log('videoTrack', videoTrack);
  const samples = await segment(mp4boxFile, videoTrack);
  console.log('samples', samples);

  const muxer = buildMuxer();
  const encoder = await buildEncoder(muxer);
  const decoder = await buildDecoder(
    videoTrack.codec,
    videoTrack.video.height,
    videoTrack.video.width,
    encoder,
    transformDescription(getDescription(mp4boxFile))
  );

  for (const sample of samples) {
    decoder.decode(
      new EncodedVideoChunk({
        data: sample.data.buffer,
        type: sample.is_sync ? 'key' : 'delta',
        timestamp: (1e6 * sample.cts) / sample.timescale,
        duration: (1e6 * sample.duration) / sample.timescale,
      })
    );
  }

  console.log('flushing');

  await decoder.flush();
  await encoder.flush();
  muxer.finalize();
  encoder.close();
  decoder.close();

  const { buffer: muxerBuffer } = muxer.target;
  console.timeEnd('transcode-t');
  return muxerBuffer;
};

const demux = (mp4boxFile: mp4box.MP4File, buffer: ArrayBufferLike): Promise<mp4box.MP4Info> => {
  const promise = new Promise<mp4box.MP4Info>((resolve, reject) => {
    mp4boxFile.onReady = (info) => {
      console.log('onReady', info);
      mp4boxFile.flush();
      resolve(info);
    };
    mp4boxFile.onError = (e) => {
      console.log('onError', e);
      reject(e);
    };

    try {
      const bufferWithStart = buffer as mp4box.MP4ArrayBuffer;
      bufferWithStart.fileStart = 0;
      mp4boxFile.appendBuffer(bufferWithStart);
      mp4boxFile.flush();
      console.log('flush');
    } catch (e) {
      console.error(e);
    }
  });

  return promise;
};

const getVideoTrackInfo = (info: mp4box.MP4Info): mp4box.MP4VideoTrack => {
  const videoTracks = info.tracks.filter((item): item is mp4box.MP4VideoTrack => item.type === 'video');

  if (videoTracks.length === 0) {
    throw new Error('No video track found');
  }

  return videoTracks[0];
};

const segment = async (mp4boxFile: mp4box.MP4File, videoTrack: mp4box.MP4VideoTrack): Promise<mp4box.MP4Sample[]> => {
  const promise = new Promise<mp4box.MP4Sample[]>((resolve, reject) => {
    mp4boxFile.onSamples = (id, user, samples) => {
      console.log('onSamples', id, user, samples);
      resolve(samples);
    };

    mp4boxFile.onError = (e) => reject(e);
  });

  mp4boxFile.setExtractionOptions(videoTrack.id, null, {
    nbSamples: 10000,
  });

  mp4boxFile.start();

  return await promise;
};

const buildMuxer = () => {
  return new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: targetWidth, height: targetHeight },
    firstTimestampBehavior: 'offset',
  });
};

const baseOptions: VideoEncoderConfig = {
  codec: targetCodec,
  width: targetWidth,
  height: targetHeight,
  framerate: 30,
  bitrate: 1000000,
  avc: { format: 'avc' },
};

const configOptions: VideoEncoderConfig[] = [
  {
    ...baseOptions,
    hardwareAcceleration: 'prefer-hardware',
  },
  {
    ...baseOptions,
    hardwareAcceleration: 'no-preference',
  },
  {
    ...baseOptions,
    hardwareAcceleration: 'prefer-software',
  },
];

const getSupportedConfig = async () => {
  for (const config of configOptions) {
    const supported = await isConfigSupported(config);
    if (supported) {
      return supported;
    }
  }
  handleError('no supported config found');
  return null;
};

const isConfigSupported = async (config: VideoEncoderConfig) => {
  try {
    const { supported, config: t } = await VideoEncoder.isConfigSupported(config);
    if (!supported) {
      console.log('encoder config not supported', t);
      return null;
    }
    return config;
  } catch (e) {
    console.log('isConfigSupported error', e);
    return null;
  }
};

const buildEncoder = async (muxer: Muxer<ArrayBufferTarget>) => {
  const config = await getSupportedConfig();
  if (!config) {
    throw new Error('no supported config found');
  }

  const init: VideoEncoderInit = {
    error: (e) => handleError('encoder error', e),
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta);
    },
  };

  const encoder = new VideoEncoder(init);
  encoder.configure(config);

  return encoder;
};

const handleError = (message: string, e?: unknown) => {
  console.warn(message, e);
  //   sendMessage({ type: 'error', message });
};

const buildDecoder = async (
  codec: string,
  codedHeight: number,
  codedWidth: number,
  encoder: VideoEncoder,
  description?: BufferSource
) => {
  codec = codec.replace('031', '001');
  console.log('codec', codec);
  const decoderConfig: VideoDecoderConfig = {
    codec: codec.startsWith('vp08') ? 'vp8' : codec,
    codedHeight,
    codedWidth,
    hardwareAcceleration: 'prefer-software',
    description,
  };

  const { supported, config: dc } = await VideoDecoder.isConfigSupported(decoderConfig);

  if (!supported) {
    console.log('decoder config not supported', dc);
    throw new Error('decoder config not supported');
  }

  const decoder = new VideoDecoder({
    output: (frame) => {
      console.log('frame', frame.codedHeight, frame.codedWidth, frame.displayHeight, frame.displayWidth);
      encoder.encode(frame);
      console.log('decoded', encoder.encodeQueueSize, decoder.decodeQueueSize);
      frame.close();
    },
    error: (e) => {
      handleError('decoder error', e);
    },
  });

  decoder.configure(decoderConfig);

  return decoder;
};
