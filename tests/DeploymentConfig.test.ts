import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const deployScript = readFileSync(new URL('../deploy/deploy.sh', import.meta.url), 'utf8');
const serviceUnit = readFileSync(new URL('../deploy/flattrade-engine.service', import.meta.url), 'utf8');
const gitignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');

describe('deployment configuration safety', () => {
  it('deploys to the service working directory and checks external runtime paths', () => {
    expect(deployScript).toContain('REMOTE_DIR="/opt/scalpx"');
    expect(serviceUnit).toContain('WorkingDirectory=/opt/scalpx');
    expect(deployScript).toContain('ENV_FILE="/etc/scalpx/env"');
    expect(serviceUnit).toContain('EnvironmentFile=/etc/scalpx/env');
    expect(deployScript).toContain('DATA_DIR="/var/lib/scalpx"');
    expect(gitignore).toContain('.env');
    expect(gitignore).toContain('.env.*');
    expect(gitignore).not.toContain('!.env.example');
    expect(deployScript).toContain('test -r \'${ENV_FILE}\'');
    expect(deployScript).toContain('test -w \'${DATA_DIR}\'');
  });

  it('requires an explicit host, excludes persistent files, and waits for liveness', () => {
    expect(deployScript).toContain('if [[ -z "${EC2_HOST}"');
    expect(deployScript).toContain("--exclude '/.env.*'");
    expect(deployScript).toContain("--exclude '*.db-*'");
    expect(deployScript).toContain("--exclude '*.sqlite-*'");
    expect(deployScript).toContain("--exclude '/data/'");
    expect(deployScript).toContain('http://127.0.0.1:3000/health/live');
    expect(deployScript).toContain('sudo systemctl is-active --quiet flattrade-engine');
    expect(deployScript).toContain('BACKUP_DIR="${DATA_DIR}/deploy-backups"');
    expect(deployScript).toContain('sudo tar -czf');
    expect(deployScript).toContain('rollback()');
    expect(deployScript).toContain('sudo rsync -a --delete');
  });
});
