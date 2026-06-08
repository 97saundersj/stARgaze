import { MESSAGES, type MessageKey } from './messages';

export type { MessageKey };

export function createMessageOverlay(element: HTMLElement) {
  function show(key: MessageKey, opacity: number): void {
    const lines = MESSAGES[key];
    element.innerHTML = lines
      .map((line) => `<p class="${line.className}">${line.text}</p>`)
      .join('');
    element.style.opacity = String(opacity);
    element.classList.toggle('visible', opacity > 0.01);
    element.setAttribute('aria-hidden', opacity > 0.01 ? 'false' : 'true');
  }

  function hide(): void {
    element.style.opacity = '0';
    element.classList.remove('visible');
    element.setAttribute('aria-hidden', 'true');
    element.innerHTML = '';
  }

  return { show, hide };
}
