/**
 * The phone book (`ops/contacts/`, §10.2 "Phone book"): every user reads it, admins write it.
 * Numbers are stored in E.164, normalised with `settings.country`; labels and numbers are unique
 * within a contact. Incoming calls from a number show the contact's name.
 */
import { invalid, notFound } from '../../errors';
import { newId } from '../../ids';
import type { Contact, ContactPhone, Db } from '../../types';
import { defineOp, type Ctx } from '../core';
import { E164, normaliseNumber } from '../validate';
import { paginate, type Page, type PageInput } from './calls';

type ContactInput = {
  displayName: string;
  company?: string | null;
  email?: string | null;
  phones?: ContactPhone[];
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function liveContact(ctx: Ctx, id: string): Contact {
  const row = ctx.db.contacts.find(
    candidate => candidate.id === id && candidate.deletedAt === null
  );
  if (row === undefined) {
    throw notFound('contact', id);
  }
  return row;
}

/** The phones of a contact, normalised and sorted by label as the API returns them. */
function normalisePhones(db: Db, phones: ContactPhone[]): ContactPhone[] {
  const out = phones.map((phone, index) => {
    const label = phone.label.trim();
    if (label === '') {
      throw invalid(
        `phones.${index}.label`,
        'contactPhoneLabel',
        'contacts: a phone needs a label'
      );
    }
    const number = normaliseNumber(db, phone.number.trim());
    if (!E164.test(number)) {
      throw invalid(
        `phones.${index}.number`,
        'contactPhoneNumber',
        `contacts: '${phone.number}' is not a resolvable phone number`,
        { value: phone.number }
      );
    }
    return { label, number };
  });
  out.forEach((phone, index) => {
    if (out.findIndex(other => other.number === phone.number) !== index) {
      throw invalid(
        `phones.${index}.number`,
        'contactPhoneDuplicateNumber',
        `contacts: duplicate phone number '${phone.number}'`,
        { value: phone.number }
      );
    }
    if (out.findIndex(other => other.label === phone.label) !== index) {
      throw invalid(
        `phones.${index}.label`,
        'contactPhoneDuplicateLabel',
        `contacts: duplicate phone label '${phone.label}'`,
        { value: phone.label }
      );
    }
  });
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

function checkFields(input: Partial<ContactInput>): void {
  if (input.displayName !== undefined && input.displayName.trim() === '') {
    throw invalid(
      'displayName',
      'contactName',
      'contacts: displayName is required'
    );
  }
  if (
    input.email !== undefined &&
    input.email !== null &&
    input.email.trim() !== '' &&
    !EMAIL.test(input.email.trim())
  ) {
    throw invalid('email', 'contactEmail', 'contacts: not an e-mail address', {
      value: input.email
    });
  }
}

const orNull = (value: string | null | undefined): string | null =>
  value === undefined || value === null || value.trim() === ''
    ? null
    : value.trim();

defineOp<PageInput, Page<Contact>>({
  name: 'contacts.list',
  minRole: 'user',
  scope: 'any',
  readOnly: true,
  run: (ctx, input) =>
    paginate(
      ctx.operation,
      ctx.db.contacts
        .filter(row => row.deletedAt === null)
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
      input
    )
});

defineOp<{ id: string }, Contact>({
  name: 'contacts.get',
  minRole: 'user',
  scope: 'any',
  readOnly: true,
  run: (ctx, input) => liveContact(ctx, input.id)
});

defineOp<ContactInput, Contact>({
  name: 'contacts.create',
  minRole: 'admin',
  run: (ctx, input) => {
    checkFields({ ...input, displayName: input.displayName ?? '' });
    const row: Contact = {
      id: newId(),
      displayName: input.displayName.trim(),
      company: orNull(input.company),
      email: orNull(input.email),
      phones: normalisePhones(ctx.db, input.phones ?? []),
      createdAt: ctx.now,
      deletedAt: null
    };
    ctx.insert('contacts', row);
    ctx.audit({
      entityKind: 'contact',
      entityId: row.id,
      before: null,
      after: row
    });
    return row;
  }
});

defineOp<{ id: string } & Partial<ContactInput>, Contact>({
  name: 'contacts.update',
  minRole: 'admin',
  run: (ctx, input) => {
    const before = liveContact(ctx, input.id);
    checkFields(input);
    const after: Contact = {
      ...before,
      displayName:
        input.displayName === undefined
          ? before.displayName
          : input.displayName.trim(),
      company:
        input.company === undefined ? before.company : orNull(input.company),
      email: input.email === undefined ? before.email : orNull(input.email),
      phones:
        input.phones === undefined
          ? before.phones
          : normalisePhones(ctx.db, input.phones)
    };
    const snapshot = {
      ...before,
      phones: before.phones.map(phone => ({ ...phone }))
    };
    ctx.put('contacts', after);
    ctx.audit({
      entityKind: 'contact',
      entityId: after.id,
      before: snapshot,
      after
    });
    return after;
  }
});

defineOp<{ id: string }, { id: string }>({
  name: 'contacts.delete',
  minRole: 'admin',
  confirm: (ctx, input) => ({
    key: 'contacts.delete',
    params: { name: liveContact(ctx, input.id).displayName },
    destructive: true
  }),
  run: (ctx, input) => {
    const row = liveContact(ctx, input.id);
    const before = { ...row };
    ctx.softDelete('contacts', row.id);
    ctx.audit({
      entityKind: 'contact',
      entityId: row.id,
      before,
      after: { ...before, deletedAt: ctx.now }
    });
    return { id: row.id };
  }
});
