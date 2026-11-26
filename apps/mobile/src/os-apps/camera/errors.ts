import type { ErrorCode } from '@hs/protocol';

/** Player-facing text per server error code. `Record<ErrorCode, …>` forces a row for every new code. */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  INVALID_MESSAGE: 'Телефон отправил непонятный запрос. Попробуйте ещё раз.',
  UNAUTHORIZED: 'Телефон не привязан к игре.',
  PROTOCOL_MISMATCH: 'Версия приложения не подходит к игре. Обновите приложение.',
  SESSION_NOT_FOUND: 'Игровая сессия не найдена.',
  SESSION_CLOSED: 'Игровая сессия закрыта.',
  SCENARIO_NOT_FOUND: 'Сценарий не найден.',
  PAIRING_CODE_INVALID: 'Неверный код привязки.',
  PAIRING_CODE_EXPIRED: 'Код привязки устарел.',
  PAIRING_RATE_LIMITED: 'Слишком много попыток привязки. Подождите.',
  DEVICE_REVOKED: 'Телефон отвязан от игры.',
  ACTION_INVALID: 'Это действие сейчас недоступно.',
  ACTION_NOT_AVAILABLE: 'Это действие сейчас недоступно.',
  ACTION_BLOCKED: 'Сейчас не до этого: что-то мешает.',
  GAME_OVER: 'Игра окончена.',
  QR_INVALID: 'Код не распознан как улика. Наведите камеру на экран игры.',
  QR_WRONG_SESSION: 'Этот код относится к другой игре.',
  QR_EXPIRED: 'Код устарел. Осмотрите место ещё раз, чтобы получить новый.',
  QR_ALREADY_USED: 'Эта улика уже сохранена.',
  QR_PRECONDITION_FAILED: 'Сейчас улику не сфотографировать: вернитесь на место и повторите.',
  SAVE_NOT_FOUND: 'Сохранение не найдено.',
  SAVE_DESYNC: 'Сохранение не совпадает с игрой.',
  GENERATION_UNSOLVABLE: 'Не удалось подготовить дело.',
  RATE_LIMITED: 'Слишком часто. Подождите немного.',
  INTERNAL: 'Что-то пошло не так на стороне игры. Попробуйте ещё раз.',
};

export const MESSAGE_SAVED = 'Улика сохранена в галерею.';
export const MESSAGE_NOT_GAME_CODE = 'Это не игровой код.';
export const MESSAGE_PAIRING_CODE = 'Это QR привязки. Улики снимаются с экрана игры.';
export const MESSAGE_OFFLINE = 'Нет связи с игрой.';
export const MESSAGE_CHECKING = 'Проверяем код…';

export interface QrResultLike {
  ok: boolean;
  error?: ErrorCode | undefined;
}

/** Text for a `qr.result`. A failure without a code is reported as an internal error. */
export function qrResultMessage(result: QrResultLike): string {
  if (result.ok) {
    return MESSAGE_SAVED;
  }
  return ERROR_MESSAGES[result.error ?? 'INTERNAL'];
}
