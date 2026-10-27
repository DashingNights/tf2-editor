export const $ = (s, root = document) => root.querySelector(s);
export const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
// Scrolls box (only) so that e shows, as scrollIntoView({ block: 'nearest' }) would. scrollIntoView also scrolls every
// box around it, the dock's split containers included: the panels beside it, the 3D view too, would shift.
export function scrollToShow(box, e) {
  if (!box || !e) return;
  const r = e.getBoundingClientRect(), b = box.getBoundingClientRect();
  if (r.top < b.top) box.scrollTop -= b.top - r.top;
  else if (r.bottom > b.bottom) box.scrollTop += Math.min(r.bottom - b.bottom, r.top - b.top);
}
