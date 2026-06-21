/**
 * Turn cron expressions into short human-readable schedule text.
 */

function formatHourMinute(hour, minute) {
  const h = parseInt(hour, 10);
  const m = parseInt(minute, 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return `${hour}:${minute}`;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  if (m === 0) return `${h12} ${ampm}`;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function formatList(items) {
  if (!items.length) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/**
 * @param {string} expr
 * @returns {string}
 */
export function humanizeCronExpr(expr) {
  const e = String(expr || '').trim();
  if (!e) return 'Unknown schedule';

  const specials = {
    '@reboot': 'At boot',
    '@hourly': 'Every hour',
    '@daily': 'Daily',
    '@weekly': 'Weekly',
    '@monthly': 'Monthly',
    '@yearly': 'Yearly',
    '@annually': 'Yearly',
  };
  if (specials[e]) return specials[e];

  const parts = e.split(/\s+/);
  if (parts.length !== 5) return e;

  const [min, hour, dom, mon, dow] = parts;
  const allDays = dom === '*' && mon === '*' && dow === '*';

  if (min === '*' && hour === '*' && allDays) return 'Every minute';

  if (/^\*\/\d+$/.test(min) && hour === '*' && allDays) {
    const n = parseInt(min.slice(2), 10);
    return n === 1 ? 'Every minute' : `Every ${n} minutes`;
  }

  if (/^\d+$/.test(min) && /^\*\/\d+$/.test(hour) && allDays) {
    const n = parseInt(hour.slice(2), 10);
    if (parseInt(min, 10) === 0) return n === 1 ? 'Every hour' : `Every ${n} hours`;
    return n === 1 ? `Every hour at minute ${min}` : `Every ${n} hours at minute ${min}`;
  }

  if (/^\d+$/.test(min) && /^[\d,]+$/.test(hour) && allDays) {
    const times = hour.split(',').map((h) => formatHourMinute(h, min));
    return `At ${formatList(times)} daily`;
  }

  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && allDays) {
    return `Daily at ${formatHourMinute(hour, min)}`;
  }

  if (min === '0' && /^\*\/\d+$/.test(hour) && allDays) {
    const n = parseInt(hour.slice(2), 10);
    return n === 1 ? 'Every hour' : `Every ${n} hours`;
  }

  return e;
}
