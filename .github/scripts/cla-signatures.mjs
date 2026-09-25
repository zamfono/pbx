// The signatures of the CLA check (cla.mjs): SIGNATURES_FILE on SIGNATURES_BRANCH, a branch of
// its own so they never touch main, created without history on the first signature. Keyed by
// account id, which survives a renamed login.
import { Buffer } from 'node:buffer';

import { hasStatus, isRecord, record } from './cla-api.mjs';

const SIGNATURES_BRANCH = 'cla-signatures';
const SIGNATURES_FILE = 'signatures/cla.json';
const NOT_FOUND = 404;
const CONFLICT = 409;
// A signature written by another pull request's run in between makes the file's sha stale; the
// write is then redone on the newer file.
const MAX_WRITE_ATTEMPTS = 3;
const JSON_INDENT = 2;

/** @typedef {import('./cla-api.mjs').Request} Request */
/** @typedef {import('./cla-api.mjs').Repo} Repo */
// `comment` is the id of the signing comment, `document` the blob sha of the CLA.md it agreed to.
/** @typedef {{ id: number, login: string, signedAt: string, pullRequest: number, comment: number, document: string }} Signature */
/** @typedef {{ signatures: Signature[], sha: string | null, branchExists: boolean }} Store */

/**
 * @param {unknown} parsed
 * @returns {Signature[]}
 */
function signaturesOf(parsed) {
  const list = record(parsed).signatures;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.filter(
    /** @returns {entry is Signature} */
    entry => isRecord(entry) && typeof entry.id === 'number'
  );
}

/**
 * @param {Request} request
 * @param {Repo} repo
 * @returns {Promise<Store>}
 */
export async function readStore(request, { owner, repo }) {
  try {
    const { data } = await request(
      `GET /repos/${owner}/${repo}/contents/${SIGNATURES_FILE}?ref=${SIGNATURES_BRANCH}`
    );
    const file = record(data);
    const content = Buffer.from(String(file.content), 'base64').toString(
      'utf8'
    );
    const sha = typeof file.sha === 'string' ? file.sha : null;
    return {
      signatures: signaturesOf(JSON.parse(content)),
      sha,
      branchExists: true
    };
  } catch (error) {
    if (!hasStatus(error, NOT_FOUND)) {
      throw error;
    }
  }
  try {
    await request(
      `GET /repos/${owner}/${repo}/git/ref/heads/${SIGNATURES_BRANCH}`
    );
    return { signatures: [], sha: null, branchExists: true };
  } catch (error) {
    if (!hasStatus(error, NOT_FOUND)) {
      throw error;
    }
    return { signatures: [], sha: null, branchExists: false };
  }
}

/**
 * Writes the signatures as the branch's first commit, with no parent, and creates the branch on it.
 * @param {Request} request
 * @param {Repo} repo
 * @param {string} content
 * @param {string} message
 * @returns {Promise<void>}
 */
async function createBranch(request, { owner, repo }, content, message) {
  const tree = record(
    (
      await request(`POST /repos/${owner}/${repo}/git/trees`, {
        tree: [{ path: SIGNATURES_FILE, mode: '100644', type: 'blob', content }]
      })
    ).data
  ).sha;
  const commit = record(
    (
      await request(`POST /repos/${owner}/${repo}/git/commits`, {
        message,
        tree,
        parents: []
      })
    ).data
  ).sha;
  await request(`POST /repos/${owner}/${repo}/git/refs`, {
    ref: `refs/heads/${SIGNATURES_BRANCH}`,
    sha: commit
  });
}

/**
 * Records a signature, rereading the file and retrying when another run wrote it in between.
 * @param {Request} request
 * @param {Repo} repo
 * @param {Signature} signature
 * @param {number} [attempt]
 * @returns {Promise<Signature[]>}
 */
export async function sign(request, repo, signature, attempt = 1) {
  const store = await readStore(request, repo);
  if (store.signatures.some(entry => entry.id === signature.id)) {
    return store.signatures;
  }
  const signatures = [...store.signatures, signature];
  const content = `${JSON.stringify({ signatures }, null, JSON_INDENT)}\n`;
  const message = `cla: @${signature.login} signs in #${signature.pullRequest}`;
  try {
    if (store.branchExists) {
      await request(
        `PUT /repos/${repo.owner}/${repo.repo}/contents/${SIGNATURES_FILE}`,
        {
          message,
          content: Buffer.from(content).toString('base64'),
          branch: SIGNATURES_BRANCH,
          ...(store.sha === null ? {} : { sha: store.sha })
        }
      );
    } else {
      await createBranch(request, repo, content, message);
    }
  } catch (error) {
    const raced = hasStatus(error, CONFLICT) || !store.branchExists;
    if (raced && attempt < MAX_WRITE_ATTEMPTS) {
      return sign(request, repo, signature, attempt + 1);
    }
    throw error;
  }
  return signatures;
}
