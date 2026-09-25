// The contributor license agreement check of cla.yaml (§12 "Open source"), run by
// actions/github-script from the default branch, never from the pull request's code.
//
// For the pull request of the triggering event it lists the GitHub accounts that authored its
// commits, compares them with the signatures cla-signatures.mjs keeps, and sets the `cla` commit
// status on the head: success once every author has signed, failure before. One comment of its
// own, found again by COMMENT_MARKER, names whoever still has to sign. A comment that is exactly
// SIGN_SENTENCE, from an author who has not signed yet, records that author's signature first,
// with the comment and the version of CLA.md it agreed to. Bots sign nothing.
//
// Everything read from the pull request (logins, commit author names, comment bodies) is data
// here: it is compared, or quoted inside code spans, and never evaluated.
import { listAll, personOf, record } from './cla-api.mjs';
import { readStore, sign } from './cla-signatures.mjs';

export const SIGN_SENTENCE = 'I have read the CLA and I hereby sign it.';
const RECHECK = 'recheck';
const COMMENT_MARKER = '<!-- cla -->';
const STATUS_CONTEXT = 'cla';

/** @typedef {import('./cla-api.mjs').Request} Request */
/** @typedef {import('./cla-api.mjs').Repo} Repo */
/** @typedef {import('./cla-api.mjs').Person} Person */
/** @typedef {{ people: Person[], unlinked: string[] }} Authors */

/**
 * The accounts that authored the commits, and the names of authors no account claims.
 * @param {unknown[]} commits
 * @returns {Authors}
 */
export function authorsOf(commits) {
  /** @type {Map<number, Person>} */
  const people = new Map();
  /** @type {Set<string>} */
  const unlinked = new Set();
  for (const commit of commits) {
    const author = personOf(record(commit).author);
    if (author === null) {
      const name = record(record(record(commit).commit).author).name;
      unlinked.add(typeof name === 'string' ? name : 'unknown');
    } else if (!author.bot) {
      people.set(author.id, { id: author.id, login: author.login });
    }
  }
  return { people: [...people.values()], unlinked: [...unlinked] };
}

/**
 * Inline code that a name cannot break out of.
 * @param {string} text
 * @returns {string}
 */
function codeSpan(text) {
  return `\`${text.replaceAll('`', "'")}\``;
}

/**
 * @param {string} documentUrl
 * @param {Person[]} unsigned
 * @param {string[]} unlinked
 * @returns {string}
 */
export function commentBody(documentUrl, unsigned, unlinked) {
  if (unsigned.length === 0 && unlinked.length === 0) {
    return `${COMMENT_MARKER}\nEvery author of this pull request has signed the [contributor license agreement](${documentUrl}). Thank you.`;
  }
  const lines = [
    COMMENT_MARKER,
    `Thank you for your pull request. Before it can be merged, every author of its commits signs the [contributor license agreement](${documentUrl}), once; it then covers all your later pull requests too. To sign, read it and comment on this pull request with exactly:`,
    '',
    '```',
    SIGN_SENTENCE,
    '```'
  ];
  if (unsigned.length > 0) {
    lines.push(
      '',
      `Not signed yet: ${unsigned.map(person => `@${person.login}`).join(', ')}`
    );
  }
  if (unlinked.length > 0) {
    lines.push(
      '',
      `Commits by ${unlinked.map(codeSpan).join(', ')} carry an e-mail address no GitHub account claims, so they cannot be signed for. Add that address to your GitHub account, or amend the commits with one it has, then comment \`${RECHECK}\`.`
    );
  }
  return lines.join('\n');
}

/**
 * Creates, updates or leaves alone the check's own comment.
 * @param {Request} request
 * @param {Repo} repo
 * @param {number} number
 * @param {string} body
 * @returns {Promise<void>}
 */
async function upsertComment(request, { owner, repo }, number, body) {
  const comments = await listAll(
    request,
    `/repos/${owner}/${repo}/issues/${number}/comments`
  );
  const own = comments.map(record).find(comment => {
    const author = personOf(comment.user);
    return (
      author?.bot === true && String(comment.body).startsWith(COMMENT_MARKER)
    );
  });
  if (own === undefined) {
    if (!body.includes(SIGN_SENTENCE)) {
      return;
    }
    await request(`POST /repos/${owner}/${repo}/issues/${number}/comments`, {
      body
    });
  } else if (own.body !== body) {
    await request(
      `PATCH /repos/${owner}/${repo}/issues/comments/${String(own.id)}`,
      { body }
    );
  }
}

/**
 * The pull request number, and the signing comment's author when the event is one.
 * @param {string} eventName
 * @param {unknown} payload
 * @returns {{ number: number, signer: (Person & { comment: number }) | null }}
 */
export function eventOf(eventName, payload) {
  const event = record(payload);
  if (eventName !== 'issue_comment') {
    return { number: Number(record(event.pull_request).number), signer: null };
  }
  const comment = record(event.comment);
  const signs =
    typeof comment.body === 'string' && comment.body.trim() === SIGN_SENTENCE;
  const author = personOf(comment.user);
  return {
    number: Number(record(event.issue).number),
    signer:
      signs && author !== null && !author.bot && typeof comment.id === 'number'
        ? { id: author.id, login: author.login, comment: comment.id }
        : null
  };
}

/**
 * The blob sha of CLA.md on the default branch: the exact text a signature agrees to.
 * @param {Request} request
 * @param {Repo} repo
 * @param {string} branch
 * @returns {Promise<string>}
 */
async function documentVersion(request, { owner, repo }, branch) {
  const { data } = await request(
    `GET /repos/${owner}/${repo}/contents/CLA.md?ref=${branch}`
  );
  return String(record(data).sha);
}

/**
 * @param {{ github: { request: Request }, context: { repo: Repo, eventName: string, payload: unknown, serverUrl: string } }} script
 * @returns {Promise<void>}
 */
export default async function run({ github, context }) {
  const request = github.request.bind(github);
  const { repo } = context;
  const { number, signer } = eventOf(context.eventName, context.payload);
  const pull = record(
    (await request(`GET /repos/${repo.owner}/${repo.repo}/pulls/${number}`))
      .data
  );
  if (pull.state !== 'open') {
    return;
  }
  const { people, unlinked } = authorsOf(
    await listAll(
      request,
      `/repos/${repo.owner}/${repo.repo}/pulls/${number}/commits`
    )
  );
  const branch = String(record(record(pull.base).repo).default_branch);
  const documentUrl = `${context.serverUrl}/${repo.owner}/${repo.repo}/blob/${branch}/CLA.md`;
  let { signatures } = await readStore(request, repo);
  const signed = () => new Set(signatures.map(entry => entry.id));
  if (
    signer !== null &&
    people.some(person => person.id === signer.id) &&
    !signed().has(signer.id)
  ) {
    signatures = await sign(request, repo, {
      id: signer.id,
      login: signer.login,
      signedAt: new Date().toISOString(),
      pullRequest: number,
      comment: signer.comment,
      document: await documentVersion(request, repo, branch)
    });
  }
  const done = signed();
  const unsigned = people.filter(person => !done.has(person.id));
  const complete = unsigned.length === 0 && unlinked.length === 0;
  await request(
    `POST /repos/${repo.owner}/${repo.repo}/statuses/${String(record(pull.head).sha)}`,
    {
      state: complete ? 'success' : 'failure',
      context: STATUS_CONTEXT,
      description: complete
        ? 'Every author has signed the CLA'
        : `${unsigned.length + unlinked.length} author(s) still to sign the CLA`,
      // eslint-disable-next-line camelcase -- the REST API's own parameter name
      target_url: documentUrl
    }
  );
  await upsertComment(
    request,
    repo,
    number,
    commentBody(documentUrl, unsigned, unlinked)
  );
}
