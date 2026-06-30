/**
 * Telegram typing indicator unit test.
 * Usage: node scripts/test/test-telegram-typing.js
 */

import { startTypingIndicator } from '../../../../lib/channels/telegram.js';

async function main() {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const intervals = [];
  const cleared = [];

  globalThis.setInterval = (fn, ms) => {
    const timer = { fn, ms, unrefCalled: false, unref() { this.unrefCalled = true; } };
    intervals.push(timer);
    return timer;
  };
  globalThis.clearInterval = (timer) => {
    cleared.push(timer);
  };

  try {
    const actions = [];
    const bot = {
      sendChatAction: async (chatId, action) => {
        actions.push({ chatId, action });
      },
    };

    const stop = startTypingIndicator(bot, 12345);
    await Promise.resolve();

    if (actions.length !== 1) throw new Error('Expected immediate typing action');
    if (actions[0].chatId !== 12345 || actions[0].action !== 'typing') {
      throw new Error('Unexpected immediate typing payload');
    }
    if (intervals.length !== 1) throw new Error('Expected one refresh interval');
    if (intervals[0].ms !== 4000) throw new Error(`Expected 4000ms refresh, got ${intervals[0].ms}`);
    if (!intervals[0].unrefCalled) throw new Error('Expected interval to be unrefed');

    intervals[0].fn();
    await Promise.resolve();
    if (actions.length !== 2) throw new Error('Expected interval refresh typing action');

    stop();
    if (cleared[0] !== intervals[0]) throw new Error('Expected stop to clear refresh interval');
    intervals[0].fn();
    await Promise.resolve();
    if (actions.length !== 2) throw new Error('Typing action should not continue after stop');

    const noopStop = startTypingIndicator({}, 12345);
    noopStop();

    console.log('Telegram typing indicator test passed.');
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
}

main().catch((err) => {
  console.error('Telegram typing indicator test failed:', err.message);
  process.exit(1);
});
