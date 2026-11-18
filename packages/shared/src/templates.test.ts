import { describe, expect, it } from 'vitest';

import {
  isTemplate,
  renderTemplate,
  templateNames,
  templateProblem,
  type TemplateContext
} from './templates.js';

// §9.4 "Templates": the one renderer of every template of a call.

const VALUES = {
  did: '+4312345617',
  callerNumber: '+43 660 1234567',
  callerName: 'Dana "D" Caller & Co\r\nX: y',
  crm: { data: { tier: 'vip', seats: 3, open: true, nested: { leaf: 1 } } }
};

function render(
  source: string,
  context: TemplateContext = 'plain'
): string | null {
  return renderTemplate(source, VALUES, context);
}

describe('helpers', () => {
  it('slice reads as String.prototype.slice: end exclusive, negatives from the end', () => {
    expect(render('{{slice did -2}}')).toBe('17');
    expect(render('{{slice did 1 3}}')).toBe('43');
    expect(render('{{slice did 3 -2}}')).toBe('123456');
    expect(render('{{slice did 99}}')).toBe('');
    expect(render('{{slice "a😀b" 1 2}}')).toBe('😀');
  });

  it('length counts characters, digits keeps digits, and they nest', () => {
    expect(render('{{length did}}')).toBe('11');
    expect(render('{{digits callerNumber}}')).toBe('436601234567');
    expect(render('{{length (digits callerNumber)}}')).toBe('12');
    expect(render('{{length missing}}')).toBe('0');
  });

  it('replace swaps every occurrence of literal text', () => {
    expect(render('{{replace callerNumber " " ""}}')).toBe('+436601234567');
    expect(render('{{replace did "+43" "0"}}')).toBe('012345617');
    expect(render('{{replace "a.b.c" "." "$&"}}')).toBe('a$&b$&c');
    expect(render('{{replace did "" "x"}}')).toBe('+4312345617');
  });

  it('stripPrefix drops a prefix the value starts with, else leaves it', () => {
    expect(render('{{stripPrefix did "+43"}}')).toBe('12345617');
    expect(render('{{stripPrefix did "+49"}}')).toBe('+4312345617');
  });
});

describe('values', () => {
  it('reads paths, a number or boolean as its text, and renders the rest empty', () => {
    expect(
      render('{{crm.data.tier}}/{{crm.data.seats}}/{{crm.data.open}}')
    ).toBe('vip/3/true');
    // A missing value or path, an object and a prototype property are no text.
    expect(
      render(
        '[{{nope}}{{crm.x.y.z}}{{crm.data.nested}}{{crm.constructor.name}}]'
      )
    ).toBe('[]');
  });

  it('returns literal text as it is, a backslash keeping braces literal', () => {
    expect(isTemplate('+4312345')).toBe(false);
    expect(render('+4312345')).toBe('+4312345');
    expect(render('\\{{did}}')).toBe('{{did}}');
  });
});

describe('escaping per field', () => {
  it('strips control characters for a line', () => {
    expect(render('n={{callerName}}', 'line')).toBe(
      'n=Dana "D" Caller & CoX: y'
    );
  });

  it('escapes for a JSON string, a form and a URL component', () => {
    expect(
      JSON.parse(render('{"name":"{{callerName}}"}', 'json') ?? '')
    ).toEqual({
      name: VALUES.callerName
    });
    expect(
      new URLSearchParams(
        render('name={{callerName}}&did={{did}}', 'form') ?? ''
      )
    ).toEqual(
      new URLSearchParams({ name: VALUES.callerName, did: VALUES.did })
    );
    expect(
      render('wss://bot.example/s/{{did}}?n={{callerNumber}}', 'url')
    ).toBe('wss://bot.example/s/%2B4312345617?n=%2B43%20660%201234567');
  });

  it('escapes what RFC 3261 does not allow unescaped in a user part', () => {
    expect(render('q-{{callerNumber}}', 'sipUser')).toBe(
      'q-+43%20660%201234567'
    );
    expect(renderTemplate('{{evil}}', { evil: 'a@b/c&é' }, 'sipUser')).toBe(
      'a%40b%2Fc%26%C3%A9'
    );
  });
});

describe('templateProblem', () => {
  it('takes mustaches of paths and of the helpers with their arguments', () => {
    for (const source of [
      'plain',
      '{{did}} {{ did }}',
      '{{crm.data.tier}}',
      '{{slice did -2}}',
      '{{slice (digits callerNumber) 0 4}}',
      '{{replace did "+" "00"}}'
    ]) {
      expect(templateProblem(source), source).toBeNull();
    }
  });

  it('refuses what is no template of the helpers alone', () => {
    const refused = {
      '{{did': /opens no/u,
      '{{#if did}}x{{/if}}': /block/u,
      '{{#each crm}}x{{/each}}': /block/u,
      '{{> partial}}': /block/u,
      '{{! note }}': /block/u,
      '{{{did}}}': /unescaped/u,
      '{{&did}}': /unescaped/u,
      '{{lookup crm "data"}}': /unknown helper 'lookup'/u,
      '{{log did}}': /unknown helper 'log'/u,
      '{{did extra=1}}': /unknown helper 'did'/u,
      '{{slice did}}': /wrong number of arguments/u,
      '{{length}}': /wrong number of arguments/u,
      '{{digits did 1}}': /wrong number of arguments/u,
      '{{slice did 1 x=2}}': /wrong number of arguments/u,
      '{{@root.did}}': /no placeholder/u,
      '{{../did}}': /no placeholder/u,
      '{{this}}': /no placeholder/u,
      '{{"did"}}': /literal/u
    };
    for (const [source, reason] of Object.entries(refused)) {
      expect(templateProblem(source) ?? '', source).toMatch(reason);
      expect(renderTemplate(source, VALUES, 'plain'), source).toBeNull();
    }
  });

  it('refuses a top-level name the field does not take, inside a helper too', () => {
    const isName = (name: string) => name === 'did';
    expect(templateProblem('{{did}}', isName)).toBeNull();
    expect(templateProblem('{{slice crm.x 1}}', isName)).toMatch(
      /unknown placeholder 'crm'/u
    );
    expect(templateNames('{{slice crm.x 1}} {{did}} {{did}}')).toEqual([
      'crm',
      'did'
    ]);
  });
});
