// Turns card text into safe HTML. Pure module (string in, string out).

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]+(?:[\s،]+[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]+)*/g;

export function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function inlineHtml(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[\[\.\.\.\]\]/g, '<span class="gap" aria-label="blank">&nbsp;</span>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(ARABIC, (m) => `<span class="ar" lang="ar" dir="rtl">${m}</span>`);
}

export function toHtml(text) {
  if (!text) return '';
  const lines = text.split('\n');
  if (lines.length === 1) return `<div class="ln" dir="auto">${inlineHtml(lines[0])}</div>`;
  return lines.map((line) => {
    const item = /^(\d+\)|-|•)\s+(.*)$/.exec(line);
    if (item) {
      const mark = item[1] === '-' || item[1] === '•' ? '•' : item[1];
      return `<div class="ln li" dir="auto"><span class="mark">${mark}</span><span>${inlineHtml(item[2])}</span></div>`;
    }
    return `<div class="ln" dir="auto">${inlineHtml(line)}</div>`;
  }).join('');
}

export function plain(text) {
  return (text || '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/\[\[\.\.\.\]\]/g, '____').replace(/\s+/g, ' ').trim();
}

export function humanInterval(ms) {
  const m = ms / 60000;
  if (m < 1) return '<1m';
  if (m < 60) return Math.round(m) + 'm';
  const h = m / 60;
  if (h < 24) return Math.round(h) + 'h';
  const d = h / 24;
  if (d < 30) return Math.round(d) + 'd';
  if (d < 365) return (d / 30).toFixed(d < 300 ? 1 : 0).replace(/\.0$/, '') + 'mo';
  return (d / 365).toFixed(1).replace(/\.0$/, '') + 'y';
}

export function humanDue(due, now) {
  const diff = due - now;
  if (diff <= 0) return 'now';
  return 'in ' + humanInterval(diff);
}
