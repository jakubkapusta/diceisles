// Runs the start-position search off the main thread, so the ocean keeps moving while it thinks.
import { findPosition } from './sim.js';

self.onmessage = ({ data: { count, perPlayer, aspect } }) => {
  self.postMessage(findPosition(count, perPlayer, aspect));
};
