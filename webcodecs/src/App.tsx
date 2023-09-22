import { useEffect, useRef, useState } from 'react';
import './App.css';
import Worker from './worker.ts?worker';
import type { IncomingMessage, OutgoingMessage } from './worker.ts';

export const retrieveCameraStream = async () => {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: 'environment',
      //full hd
      width: 1920,
      height: 1080,
    },
  });
  return stream;
};

const mimeTypes = [
  'video/mp4; codecs=avc1.42E01E',
  'video/mp4; codecs=avc1.42E01F',
  'video/mp4;',
  'video/mp4',
  undefined,
];

const getMediaRecorderWithSupportedMimeType = (stream: MediaStream) => {
  for (const mimeType of mimeTypes) {
    try {
      return new MediaRecorder(stream, { mimeType });
    } catch (e) {
      console.warn('mimeType', mimeType, 'not supported', e);
    }
  }
};

const sendMessage = (workerInstance: Worker, message: IncomingMessage, transferable?: Transferable[]) =>
  workerInstance.postMessage(message, transferable ?? []);

function App() {
  const [statusText, setStatusText] = useState('Idle');
  const [workerInstance, setWorkerInstance] = useState<Worker | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [recorder, setRecorder] = useState<MediaRecorder | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const inputVideoRef = useRef<HTMLVideoElement>(null);
  const outputVideoRef = useRef<HTMLVideoElement>(null);
  const aRef = useRef<HTMLAnchorElement>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);

  useEffect(() => {
    if (!workerInstance) return;

    const messageHandler = ({ data }: MessageEvent<OutgoingMessage>) => {
      if (data.type === 'error') {
        setLog((prevLog) => [...prevLog, data.message]);
      } else if (data.type === 'pong') {
        alert('pong');
      } else if (data.type === 'buffer' && outputVideoRef.current) {
        alert('recived buffer');
        const { buffer } = data;
        const blob = new Blob([buffer], { type: 'video/mp4' });
        const url = URL.createObjectURL(blob);
        outputVideoRef.current.src = url;
        outputVideoRef.current.play();
        if (aRef.current) aRef.current.href = url;

        setStream(null);
        setWorkerInstance(null);
      }
    };

    workerInstance.addEventListener('message', messageHandler);
    return () => {
      workerInstance.removeEventListener('message', messageHandler);
    };
  }, [workerInstance]);

  return (
    <div className='main'>
      <h2>Status</h2>
      <div>{statusText}</div>
      <label htmlFor='video-url-input'>Video URL</label>
      <button
        onClick={() => {
          const worker = new Worker();
          setWorkerInstance(worker);
        }}
      >
        Start Worker
      </button>
      <button
        disabled={!!stream}
        onClick={async () => {
          try {
            setStatusText('Intializing camera');
            const stream = await retrieveCameraStream();
            const worker = new Worker();
            setWorkerInstance(worker);
            setStream(stream);

            if (!inputVideoRef.current) return;

            inputVideoRef.current.srcObject = stream;
            const recorder = getMediaRecorderWithSupportedMimeType(stream);
            if (!recorder) throw new Error('No supported mime type found');

            console.log('mime type used', recorder.mimeType ?? 'default');
            setRecorder(recorder);
            // inputVideoRef.current.play();
            setStatusText('Camera ready');
          } catch (e) {
            console.error('init error', e);
            // alert(`Failed to initialize camera: ${e instanceof Error ? e.message : 'Unknown error'}`);
          }
        }}
      >
        Start Camera
      </button>
      <button
        disabled={!stream || isRecording}
        onClick={() => {
          if (!stream || !recorder) return;

          recorder.addEventListener('dataavailable', (e) => {
            const blob = e.data;
            const url = URL.createObjectURL(blob);
            if (outputVideoRef.current) {
              outputVideoRef.current.src = url;
              outputVideoRef.current.play();
            }

            if (aRef.current) aRef.current.href = url;
            blob.arrayBuffer().then((buffer) => {
              setStatusText('Ready for encoding');
              setBuffer(buffer);
            });
          });

          recorder.start();
          setIsRecording(true);
        }}
      >
        Record Video
      </button>
      <button
        disabled={!isRecording}
        onClick={() => {
          if (!stream || !recorder) return;

          recorder.stop();

          stream.getTracks().forEach((track) => track.stop());
          // sendMessage(workerInstance, { type: 'finish' });
          setStatusText('Finalizing');
          setIsRecording(false);
        }}
      >
        Stop
      </button>
      <input
        type='file'
        accept='video/*'
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file) return;

          const url = URL.createObjectURL(file);
          if (inputVideoRef.current) {
            inputVideoRef.current.src = url;
            inputVideoRef.current.play();
          }

          file.arrayBuffer().then((buffer) => {
            setBuffer(buffer);
          });
        }}
      ></input>
      <button
        disabled={!buffer || !workerInstance}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!buffer || !workerInstance) return;

          sendMessage(workerInstance, { type: 'start', arrayBuffer: buffer }, [buffer]);
        }}
      >
        Start Transcoding
      </button>
      <div className='video-container'>
        <label htmlFor='video-file-input'>Input Video File</label>
        <video className='input-video' autoPlay muted playsInline id='input-video' ref={inputVideoRef} />
        <label htmlFor='video-file-input'>Output Video File</label>
        <video
          className='output-video'
          id='output-video'
          controls
          ref={outputVideoRef}
          onError={(e) => console.error('output video error', e)}
          onErrorCapture={(e) => console.error('output video error capture', e)}
        />

        <a download={'encoded.mp4'} ref={aRef}>
          Click to download
        </a>
      </div>
      <textarea className='log' value={log.join('\n')} readOnly rows={10} cols={100} />
    </div>
  );
}

export default App;
