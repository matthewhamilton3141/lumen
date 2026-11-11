// Preview rendering off the main thread, so playback and the controls stay smooth.
// Every 'frame' gets a 'done' reply; the page sends at most one frame at a time and
// skips frames while the worker is busy.
import { createPreview } from './preview.js';

let preview = null;
self.onmessage = ({ data: m }) => {
  if (m.type === 'init') { preview = createPreview(m.out, m.tiles); return; }
  try {
    if (m.type === 'frame') preview.frame(m);
    else if (m.type === 'thumbs') preview.thumbs(m);
  } catch (err) {
    console.error(err);
  } finally {
    if (m.type === 'frame') self.postMessage({ type: 'done' });
  }
};
