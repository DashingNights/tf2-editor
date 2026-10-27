// In-app modal on a native <dialog>: never blocks the event loop like confirm()/alert().
// ask(message, buttons) resolves with the chosen button index; Escape picks the last button.
import { el } from './dom.js';

let dlg;
export function ask(message, buttons = ['OK', 'Cancel']) {
  dlg ??= document.body.appendChild(el('dialog', { id: 'ask' }));
  dlg.replaceChildren(
    el('p', { textContent: message }),
    el('div', { className: 'row' }, ...buttons.map((b, i) => el('button', { textContent: b, className: i ? '' : 'primary', onclick: () => dlg.close(String(i)) }))),
  );
  dlg.returnValue = '';
  dlg.showModal();
  dlg.querySelector('button').focus();
  return new Promise(res => { dlg.onclose = () => res(dlg.returnValue === '' ? buttons.length - 1 : +dlg.returnValue); });
}

export const notice = message => ask(message, ['OK']);
