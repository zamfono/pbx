import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { OpError } from '../ops/types.js';
import { callHelp } from './guide.js';
import { listPrompts, parseRecipeFrontMatter } from './prompts.js';

const RECIPE_CONTENT = `---
title: Onboard an employee
arguments:
  - name: employeeName
    description: The employee's full name
    required: true
  - name: extension
    description: Desired extension number
    required: false
---
# Onboard an employee

Steps.
`;

const guideDir = mkdtempSync(path.join(tmpdir(), 'zamfono-guide-'));
const recipesDir = path.join(guideDir, 'recipes');
mkdirSync(recipesDir);
writeFileSync(path.join(guideDir, 'mental-model.md'), '# Mental model\n');
writeFileSync(path.join(recipesDir, 'onboard-employee.md'), RECIPE_CONTENT);

afterAll(() => {
  rmSync(guideDir, { recursive: true, force: true });
});

describe('parseRecipeFrontMatter', () => {
  it('reads the title and the flat arguments list', () => {
    expect(parseRecipeFrontMatter(RECIPE_CONTENT)).toEqual({
      title: 'Onboard an employee',
      arguments: [
        {
          name: 'employeeName',
          description: "The employee's full name",
          required: true
        },
        {
          name: 'extension',
          description: 'Desired extension number',
          required: false
        }
      ]
    });
  });

  it('returns an empty title and no arguments when there is no front matter', () => {
    expect(parseRecipeFrontMatter('# Just a heading\n')).toEqual({
      title: '',
      arguments: []
    });
  });
});

describe('listPrompts', () => {
  it('publishes one prompt per recipe with its title and parameters', () => {
    expect(listPrompts(recipesDir)).toEqual([
      {
        name: 'onboard-employee',
        title: 'Onboard an employee',
        description: 'Onboard an employee',
        arguments: [
          {
            name: 'employeeName',
            description: "The employee's full name",
            required: true
          },
          {
            name: 'extension',
            description: 'Desired extension number',
            required: false
          }
        ]
      }
    ]);
  });
});

describe('callHelp', () => {
  it('resolves a recipe name as a help topic', () => {
    const result = callHelp(
      { topic: 'onboard-employee' },
      guideDir,
      recipesDir
    );
    expect(result).toEqual({
      topic: 'onboard-employee',
      content: RECIPE_CONTENT
    });
  });

  it('lists guide topics and recipe topics together', () => {
    const result = callHelp({}, guideDir, recipesDir);
    expect(result).toEqual({
      topics: ['mental-model', 'onboard-employee']
    });
  });

  it('throws on an unknown topic', () => {
    expect(() =>
      callHelp({ topic: 'no-such-topic' }, guideDir, recipesDir)
    ).toThrow(OpError);
  });
});
