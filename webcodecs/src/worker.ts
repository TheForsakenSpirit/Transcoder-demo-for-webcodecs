import { transcode } from './transcoderWorker';

console.log('worker start');

const handleError = (message: string, e?: unknown) => {
  console.warn(message, e);
  const errorMessage: MessageError = { type: 'error', message };
  sendMessage(errorMessage);
};

self.addEventListener('message', (event) => {
  console.log('worker message', event.data);

  if (!isMessage(event.data)) {
    handleError('unknown message', event.data);
    return;
  }

  const { type } = event.data;
  switch (type) {
    case 'start':
      transcode(event.data.arrayBuffer).then((buffer) => {
        sendMessage({ type: 'buffer', buffer }, [buffer]);
      });
      break;
    case 'ping':
      sendMessage({ type: 'pong' });
      break;
    default:
      handleError('unknown message type', type);
      break;
  }
});

export const sendMessage = (message: OutgoingMessage, transfer?: Transferable[]) => {
  postMessage(message, { transfer });
};

type MessageStart = {
  type: 'start';
  arrayBuffer: ArrayBufferLike;
};

type Ping = {
  type: 'ping';
};

export type IncomingMessage = MessageStart | Ping;

export type MessageError = {
  type: 'error';
  message: string;
};

type OutputBuffer = {
  type: 'buffer';
  buffer: ArrayBuffer;
};

type Pong = {
  type: 'pong';
};

export type OutgoingMessage = MessageError | OutputBuffer | Pong;
const isMessage = (data: unknown): data is IncomingMessage => !!data && typeof data === 'object' && 'type' in data;
