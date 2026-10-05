import type { State } from './recorder.ts';

type Message = { type: string } & Record<string, unknown>;
type Send = (message: Message) => Promise<State>;
type Subscribe = (listener: (state: State) => void) => () => void;

// Binds the editor to one guide: every command names it, and live updates
// for other guides are ignored. When the active guide moves to the library
// (a new capture starts) or is deleted, the editor reloads it by id.
export function bindGuide(send: Send, subscribe: Subscribe, guideId: string): { send: Send; subscribe: Subscribe } {
  const bound: Send = message => {
    // A guide deleted elsewhere (or a stale link) shows the empty state.
    if (message.type === 'STATUS') return send({ type: 'GET_GUIDE', guideId }).catch(error => {
      if (/not found/i.test(String(error))) return { recording: null, revision: Number.MAX_SAFE_INTEGER };
      throw error;
    });
    if (message.type === 'DELETE') return send({ type: 'DELETE_GUIDE', guideId });
    return send({ ...message, guideId });
  };
  return {
    send: bound,
    subscribe: listener => {
      let following = false;
      return subscribe(state => {
        if (state.recording?.id === guideId) { following = true; listener(state); return; }
        if (!following) return;
        following = false;
        void bound({ type: 'STATUS' }).then(listener, () => listener({ recording: null, revision: Number.MAX_SAFE_INTEGER }));
      });
    },
  };
}
