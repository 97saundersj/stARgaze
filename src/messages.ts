export type MessageKey = 'question' | 'moment';

export interface MessageLine {
  text: string;
  className: string;
  color?: 'white' | 'gold';
  worldWidth?: number;
}

export const MESSAGES: Record<MessageKey, MessageLine[]> = {
  question: [
    { text: 'ESTELLE', className: 'message-name', color: 'white', worldWidth: 0.45 },
    { text: '♥', className: 'message-accent', color: 'gold', worldWidth: 0.12 },
    { text: 'VEUX-TU M\'ÉPOUSER ?', className: 'message-body', color: 'white', worldWidth: 0.55 },
  ],
  moment: [
    { text: 'TURN AROUND', className: 'message-name', color: 'white', worldWidth: 0.5 },
  ],
};
