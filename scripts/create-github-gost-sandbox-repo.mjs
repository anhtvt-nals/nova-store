const { owner: targetOwner, token } = parseProviderKey(required('GITHUB_PROVIDER_API_KEY'));
const templateOwner = required('GITHUB_TEMPLATE_OWNER');
const templateRepository = 'nodenesia-gost-template';
const targetRepository = 'nodenesia-gost-sandbox';
const description = 'Public short-lived GOST v3 test runner for Nodenesia';

for (const [name, value] of Object.entries({ GITHUB_TEMPLATE_OWNER: templateOwner, GITHUB_OWNER: targetOwner })) {
  if (!/^[A-Za-z0-9-]+$/.test(value)) fail(`${name} contains unsupported characters`);
}
for (const [name, value] of Object.entries({ GITHUB_TEMPLATE_REPO: templateRepository, GITHUB_REPO: targetRepository })) {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) fail(`${name} contains unsupported characters`);
}
async function main() {
  const authenticatedUser = await github('/user', 'GET', undefined, 200);
  if (authenticatedUser?.login?.toLowerCase() !== targetOwner.toLowerCase()) {
    fail(`The owner in GITHUB_PROVIDER_API_KEY must match the PAT owner (${authenticatedUser?.login || 'unknown'})`);
  }

  const existing = await github(`/repos/${targetOwner}/${targetRepository}`, 'GET', undefined, [200, 404]);
  if (existing.status === 200) {
    const workflow = await github(`/repos/${targetOwner}/${targetRepository}/contents/.github/workflows/gost-sandbox.yml`, 'GET', undefined, [200, 404]);
    if (workflow.status !== 200) {
      fail(`Repository ${targetOwner}/${targetRepository} already exists but does not contain the Nodenesia GOST workflow; refusing to overwrite it`);
    }
    console.log(`Using existing repository: https://github.com/${targetOwner}/${targetRepository}`);
    return;
  }

  console.log(`Creating ${targetOwner}/${targetRepository} from ${templateOwner}/${templateRepository}…`);
  const result = await github(
    `/repos/${templateOwner}/${templateRepository}/generate`,
    'POST',
    {
      owner: targetOwner,
      name: targetRepository,
      description,
      private: false,
      include_all_branches: false,
    },
    201,
  );
  console.log(`Done: ${result.html_url || `https://github.com/${targetOwner}/${targetRepository}`}`);
  console.log('Next: add the seven required Actions secrets listed in the repository README.');
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
