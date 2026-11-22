import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACTIONS_BY_ROLE,
  ClientEvent,
  ClientMessage,
  ERROR_CODES,
  PROTOCOL_VERSION,
  PlayerAction,
  ServerMessage,
} from '@hs/protocol';
import {
  GODOT_CONSTANTS_PATH,
  constantName,
  gdString,
  renderGodotConstants,
} from '../scripts/godot.ts';

const file = new URL(`../../../${GODOT_CONSTANTS_PATH}`, import.meta.url);
const text = renderGodotConstants();

/** `const NAME: String = "value"` declarations of the rendered file. */
const strings = new Map(
  [...text.matchAll(/^const ([A-Z0-9_]+): String = (".*")$/gm)].map(([, name, literal]) => [
    name as string,
    JSON.parse(literal as string) as string,
  ]),
);

/** Values of a `const NAME: Array[String] = [...]` list, resolved through `strings`. */
function list(name: string): string[] {
  const body = new RegExp(
    `^const ${name}: Array\\[String\\] = \\[\\n((?:\\t[A-Z0-9_]+,\\n)*)\\]$`,
    'm',
  ).exec(text)?.[1];
  if (body === undefined) throw new Error(`no list ${name}`);
  return body
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => strings.get(line.trim().replace(/,$/, '')) as string);
}

const types = (options: readonly { shape: { type: { value: string } } }[]): string[] =>
  options.map((option) => option.shape.type.value);

describe('protocol_constants.gd', () => {
  it('is stable across repeated generation', () => {
    expect(renderGodotConstants()).toBe(text);
  });

  it('matches the committed file exactly', () => {
    expect(readFileSync(file, 'utf8')).toBe(text);
  });

  it('is marked as generated, uses LF line endings and tab indentation', () => {
    expect(text.split('\n')[0]).toBe('# СГЕНЕРИРОВАНО — не редактировать.');
    expect(text).not.toContain('\r');
    expect(text).not.toMatch(/^ +\S/m);
    expect(text.endsWith(']\n') || text.endsWith('}\n')).toBe(true);
  });

  it('declares the ProtocolConstants class and PROTOCOL_VERSION', () => {
    expect(text).toMatch(/^class_name ProtocolConstants$/m);
    expect(text).toContain(`const PROTOCOL_VERSION: int = ${String(PROTOCOL_VERSION)}\n`);
  });

  it('lists the real contract values in declaration order', () => {
    expect(list('CLIENT_MESSAGE_TYPES')).toEqual(types(ClientMessage.options));
    expect(list('SERVER_MESSAGE_TYPES')).toEqual(types(ServerMessage.options));
    expect(list('EVENT_TYPES')).toEqual(types(ClientEvent.options));
    expect(list('ERROR_CODES')).toEqual([...ERROR_CODES]);
    expect(list('ACTION_TYPES')).toEqual(types(PlayerAction.options));
    expect(list('ROLES')).toEqual(Object.keys(ACTIONS_BY_ROLE));
    expect(list('DESKTOP_ACTIONS')).toEqual([...ACTIONS_BY_ROLE.desktop]);
    expect(list('PHONE_ACTIONS')).toEqual([...ACTIONS_BY_ROLE.phone]);
  });

  it('declares every constant name once', () => {
    const names = [...text.matchAll(/^const ([A-Z0-9_]+):/gm)].map(([, name]) => name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('constantName', () => {
  it('converts dotted and camelCase values to UPPER_SNAKE_CASE', () => {
    expect(constantName('MSG', 'action.request')).toBe('MSG_ACTION_REQUEST');
    expect(constantName('ACTION', 'examineLocation')).toBe('ACTION_EXAMINE_LOCATION');
    expect(constantName('ERROR', 'QR_ALREADY_USED')).toBe('ERROR_QR_ALREADY_USED');
    expect(constantName('', 'desktopActions')).toBe('DESKTOP_ACTIONS');
  });

  it('rejects values that do not yield an identifier', () => {
    expect(() => constantName('', '...')).toThrow();
    expect(() => constantName('', '1st')).toThrow();
  });
});

describe('gdString', () => {
  it('escapes quotes, backslashes and control characters', () => {
    expect(gdString('a"b\\c\nd\te\u0001')).toBe('"a\\"b\\\\c\\nd\\te\\u0001"');
  });

  it('keeps non-ASCII text as is', () => {
    expect(gdString('Вестибюль')).toBe('"Вестибюль"');
  });

  it('rejects lone surrogates', () => {
    expect(() => gdString('\ud800')).toThrow();
  });
});
