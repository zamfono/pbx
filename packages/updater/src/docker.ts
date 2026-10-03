import http from 'node:http';

/**
 * What the updater learns about the stack from its own container, over the runtime's socket
 * (Docker's API, or Podman's Docker-compatible one): Compose labels every container it creates
 * with the project's name and the host directory it ran in.
 */
export type ComposeProject = {
  name: string;
  workingDir: string;
};

const HTTP_OK = 200;

function getJson(socketPath: string, requestPath: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = http.get({ socketPath, path: requestPath }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode !== HTTP_OK) {
          reject(
            new Error(
              `the runtime answered ${String(response.statusCode)} for ${requestPath}: ${text}`
            )
          );
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    request.on('error', reject);
  });
}

/** The labels `docker compose` sets, read off `labels`; throws when one is missing. */
export function projectFromLabels(
  labels: Record<string, string | undefined>
): ComposeProject {
  const name = labels['com.docker.compose.project'];
  const workingDir = labels['com.docker.compose.project.working_dir'];
  if (!name || !workingDir) {
    throw new Error(
      'the updater container carries no Compose project labels; start the stack with docker compose or podman compose'
    );
  }
  return { name, workingDir };
}

/** The Compose project of container `id`, this process's own. */
export async function inspectProject(
  socketPath: string,
  id: string
): Promise<ComposeProject> {
  const body = (await getJson(
    socketPath,
    `/containers/${encodeURIComponent(id)}/json`
  )) as { Config?: { Labels?: Record<string, string> } };
  return projectFromLabels(body.Config?.Labels ?? {});
}
