import {
  ACTIONS_BY_ROLE,
  ClientEvent,
  ClientMessage,
  ERROR_CODES,
  PROTOCOL_VERSION,
  PlayerAction,
  ServerMessage,
} from '../src/index.ts';

/** Path of the generated file relative to the repository root. */
export const GODOT_CONSTANTS_PATH = 'apps/desktop/src/net/protocol_constants.gd';

const IDENTIFIER = /^[A-Z][A-Z0-9_]*$/;

/** `action.request` -> `ACTION_REQUEST`, `examineLocation` -> `EXAMINE_LOCATION`. */
export function constantName(prefix: string, value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  const name = prefix === '' ? words : `${prefix}_${words}`;
  if (!IDENTIFIER.test(name)) throw new Error(`cannot derive a GDScript constant from "${value}"`);
  return name;
}

/**
 * GDScript string literal. JSON escapes (`\"`, `\\`, `\n`, `\t`, `\uXXXX`, ...) are all valid in
 * GDScript; lone surrogates are not representable, so they are rejected.
 */
export function gdString(value: string): string {
  if (!value.isWellFormed()) throw new Error(`string is not well-formed UTF-16: ${value}`);
  return JSON.stringify(value);
}

function literals(options: readonly { shape: { type: { value: string } } }[]): string[] {
  return options.map((option) => option.shape.type.value);
}

interface Group {
  comment: string;
  prefix: string;
  values: readonly string[];
  /** Name of the typed array listing the group's constants. */
  list: string;
  listComment: string;
}

/** Deterministic `protocol_constants.gd`: order follows the declaration order in @hs/protocol. */
export function renderGodotConstants(): string {
  const roles = Object.keys(ACTIONS_BY_ROLE) as (keyof typeof ACTIONS_BY_ROLE)[];
  const groups: Group[] = [
    {
      comment: 'Типы сообщений клиент -> сервер (ClientMessage.type).',
      prefix: 'MSG',
      values: literals(ClientMessage.options),
      list: 'CLIENT_MESSAGE_TYPES',
      listComment: 'Все типы сообщений клиент -> сервер.',
    },
    {
      comment: 'Типы сообщений сервер -> клиент (ServerMessage.type).',
      prefix: 'MSG',
      values: literals(ServerMessage.options),
      list: 'SERVER_MESSAGE_TYPES',
      listComment: 'Все типы сообщений сервер -> клиент.',
    },
    {
      comment: 'Типы событий в сообщении `event` (ClientEvent.type).',
      prefix: 'EVENT',
      values: literals(ClientEvent.options),
      list: 'EVENT_TYPES',
      listComment: 'Все типы событий.',
    },
    {
      comment: 'Коды ошибок (ErrorCode).',
      prefix: 'ERROR',
      values: ERROR_CODES,
      list: 'ERROR_CODES',
      listComment: 'Все коды ошибок.',
    },
    {
      comment: 'Роли подключений (ключи ACTIONS_BY_ROLE).',
      prefix: 'ROLE',
      values: roles,
      list: 'ROLES',
      listComment: 'Все роли.',
    },
    {
      comment: 'Типы действий игрока (PlayerAction.type).',
      prefix: 'ACTION',
      values: literals(PlayerAction.options),
      list: 'ACTION_TYPES',
      listComment: 'Все типы действий, включая отправляемые только сервером.',
    },
  ];

  const lines: string[] = [
    '# СГЕНЕРИРОВАНО — не редактировать.',
    '# Источник: @hs/protocol (packages/protocol/src). Обновление: npm run protocol:gen.',
    '# Актуальность проверяют npm run protocol:check и тесты @hs/protocol.',
    'class_name ProtocolConstants',
    'extends RefCounted',
    '',
    '## Версия протокола (ADR 0009); при несовпадении сервер отвечает PROTOCOL_MISMATCH.',
    `const PROTOCOL_VERSION: int = ${String(PROTOCOL_VERSION)}`,
  ];

  /** Constant name -> value; one constant per value even when a value repeats across groups. */
  const declared = new Map<string, string>();
  const declare = (name: string, value: string): boolean => {
    const previous = declared.get(name);
    if (previous !== undefined && previous !== value) {
      throw new Error(`constant ${name} maps to both "${previous}" and "${value}"`);
    }
    declared.set(name, value);
    return previous === undefined;
  };
  const arrays = new Set<string>();

  const typedArray = (name: string, items: readonly string[]): string[] => {
    if (declared.has(name) || arrays.has(name)) throw new Error(`duplicate constant ${name}`);
    arrays.add(name);
    return [`const ${name}: Array[String] = [`, ...items.map((item) => `\t${item},`), ']'];
  };

  for (const group of groups) {
    if (new Set(group.values).size !== group.values.length) {
      throw new Error(`duplicate value in ${group.list}`);
    }
    lines.push('', `# ${group.comment}`);
    const names = group.values.map((value) => {
      const name = constantName(group.prefix, value);
      if (declare(name, value)) lines.push(`const ${name}: String = ${gdString(value)}`);
      return name;
    });
    lines.push(`## ${group.listComment}`, ...typedArray(group.list, names));
  }

  lines.push('', '# Действия, которые может запросить каждая роль (ACTIONS_BY_ROLE).');
  for (const role of roles) {
    const names = ACTIONS_BY_ROLE[role].map((action) => constantName('ACTION', action));
    lines.push(...typedArray(constantName('', `${role}Actions`), names));
  }
  lines.push(
    '## Роль -> Array[String] разрешённых ей действий.',
    'const ACTIONS_BY_ROLE: Dictionary = {',
  );
  for (const role of roles) {
    lines.push(`\t${constantName('ROLE', role)}: ${constantName('', `${role}Actions`)},`);
  }
  lines.push('}');

  for (const name of declared.keys()) {
    if (arrays.has(name)) throw new Error(`duplicate constant ${name}`);
  }
  return `${lines.join('\n')}\n`;
}
