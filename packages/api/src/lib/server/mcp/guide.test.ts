import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

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

// The guide the build bundles (§10.5), read from disk to check what the bundle serves.
const GUIDE_DIR = path.resolve(
  import.meta.dirname,
  '../../../../../../docs/guide'
);
const RECIPES_DIR = path.join(GUIDE_DIR, 'recipes');

function topicNames(dir: string): string[] {
  return readdirSync(dir)
    .filter(file => file.endsWith('.md'))
    .map(file => path.basename(file, '.md'));
}

const TOPICS = [
  ...new Set([...topicNames(GUIDE_DIR), ...topicNames(RECIPES_DIR)])
].sort();

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
    const prompts = listPrompts();
    expect(prompts.map(prompt => prompt.name).sort()).toEqual(
      topicNames(RECIPES_DIR).sort()
    );
    const recipe = readFileSync(
      path.join(RECIPES_DIR, 'onboard-employee.md'),
      'utf8'
    );
    const { title, arguments: args } = parseRecipeFrontMatter(recipe);
    expect(title).not.toBe('');
    expect(prompts.find(prompt => prompt.name === 'onboard-employee')).toEqual({
      name: 'onboard-employee',
      title,
      description: title,
      arguments: args
    });
  });
});

describe('callHelp', () => {
  it('resolves a recipe name as a help topic', () => {
    expect(callHelp({ topic: 'onboard-employee' })).toEqual({
      topic: 'onboard-employee',
      content: readFileSync(
        path.join(RECIPES_DIR, 'onboard-employee.md'),
        'utf8'
      )
    });
  });

  it('lists guide topics and recipe topics together', () => {
    expect(callHelp({})).toEqual({ topics: TOPICS });
  });

  it('throws on an unknown topic, naming how to list the topics and the topics themselves', () => {
    expect(() => callHelp({ topic: 'no-such-topic' })).toThrow(OpError);
    expect(() => callHelp({ topic: 'no-such-topic' })).toThrow(
      `unknown help topic 'no-such-topic'; call zamfono.help without a topic for the list: ${TOPICS.join(', ')}`
    );
  });

  it('reads `index` as the topic list', () => {
    expect(callHelp({ topic: 'index' })).toEqual({ topics: TOPICS });
  });
});
