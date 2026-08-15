import { readFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = fileURLToPath(new URL('.', import.meta.url));
const templateDirectory = join(scriptDirectory, '..', 'templates', 'github-actions-gost-sandbox');
const { owner, token } = parseProviderKey(required('GITHUB_PROVIDER_API_KEY'));
const repository = 'nodenesia-gost-template';
const description = 'Public GOST v3 test-runner template for Nodenesia';

if (!/^[A-Za-z0-9_.-]+$/.test(repository)) fail('GITHUB_REPO contains unsupported characters');

const files = [
  '.github/workflows/gost-sandbox.yml',
  'README.md',
];

async function main() {
  const authenticatedUser = await github('/user', 'GET', undefined, 200);
  if (authenticatedUser?.login?.toLowerCase() !== owner.toLowerCase()) {
    fail(`The owner in GITHUB_PROVIDER_API_KEY must match the PAT owner (${authenticatedUser?.login || 'unknown'})`);
  }

  const existing = await github(`/repos/${owner}/${repository}`, 'GET', undefined, [200, 404]);
  if (existing.status === 200) {
    if (!existing.is_template) {
      fail(`Repository ${owner}/${repository} already exists but is not a GitHub template; refusing to overwrite it`);
    }
    console.log(`Updating existing template: https://github.com/${owner}/${repository}`);
  } else {
    const createBody = { name: repository, description, private: false, has_issues: false, has_projects: false, has_wiki: false, auto_init: false };
    console.log(`Creating public repository ${owner}/${repository}…`);
    await github('/user/repos', 'POST', createBody, 201);
  }

  try {
    for (const templateFile of files) {
      const source = join(templateDirectory, templateFile);
      const content = await readFile(source);
      const destination = `/repos/${owner}/${repository}/contents/${encodePath(templateFile)}`;
      const current = await github(destination, 'GET', undefined, [200, 404]);
      console.log(`${current.status === 200 ? 'Updating' : 'Adding'} ${templateFile}…`);
      await github(destination, 'PUT', {
        message: `${current.status === 200 ? 'Update' : 'Add'} ${basename(templateFile)}`,
        content: content.toString('base64'),
        ...(current.status === 200 ? { sha: current.sha } : {}),
      }, [200, 201]);
    }

    console.log('Marking repository as a template…');
    await github(`/repos/${owner}/${repository}`, 'PATCH', { is_template: true }, 200);
  } catch (error) {
    console.error(`Repository ${owner}/${repository} was created but setup did not finish. It was left intact for safe manual repair.`);
    throw error;
  }

  console.log(`Done: https://github.com/${owner}/${repository}`);
  console.log('Next: configure GITHUB_TEMPLATE_OWNER and GITHUB_CONTROL_PLANE_URL in the Nodenesia API.');
}

async function github(path, method, body, expectedStatus) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  const payload = await response.json().catch(() => undefined);
  if (expected.includes(response.status)) return { status: response.status, payload, ...(payload && typeof payload === 'object' ? payload : {}) };

  const detail = payload && typeof payload === 'object' ? payload : {};
  const message = typeof detail.message === 'string' ? detail.message : response.statusText;
  throw new Error(`GitHub API ${method} ${path} failed (${response.status}): ${message}`);
}

function parseProviderKey(value) {
  const separator = value.indexOf('|');
  if (separator <= 0 || separator !== value.lastIndexOf('|')) {
    fail('GITHUB_PROVIDER_API_KEY must use the exact format GITHUB_OWNER|GITHUB_API_KEY');
  }
  const owner = value.slice(0, separator).trim();
  const token = value.slice(separator + 1).trim();
  if (!/^[A-Za-z0-9-]+$/.test(owner) || !token) fail('GITHUB_PROVIDER_API_KEY is invalid');
  return { owner, token };
}

function encodePath(path) {
  return relative('/', path).split('/').map(encodeURIComponent).join('/');
}

function required(name) {
  const value = process.env[name];
  if (!value) fail(`${name} is required`);
  return value;
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

main().catch(error => {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
