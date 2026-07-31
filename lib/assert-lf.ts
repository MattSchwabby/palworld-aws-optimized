import * as fs from 'fs';
import * as path from 'path';

/**
 * Refuse to synth if anything destined for the Linux instance has CRLF endings.
 *
 * A single carriage return in a shebang fails as
 *   /usr/bin/env: 'bash\r': No such file or directory
 * and takes the entire bootstrap down. The instance then has no game server, and
 * because bootstrap re-downloads these files on every boot, patching them on the box
 * is undone the moment it retries. It is a deploy-time mistake with a runtime
 * blast radius, so it belongs here rather than in a code review.
 *
 * .gitattributes covers files arriving through git. This covers files a Windows
 * editor or a careless script rewrote locally, which is how it happened.
 */
export function assertUnixLineEndings(dir: string): void {
  const offenders: string[] = [];

  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(sh|py)$/.test(entry.name)) {
        if (fs.readFileSync(full).includes('\r\n')) {
          offenders.push(path.relative(process.cwd(), full));
        }
      }
    }
  };

  walk(dir);

  if (offenders.length > 0) {
    throw new Error(
      [
        'Refusing to build: these files have Windows CRLF line endings and would',
        'break the instance bootstrap on the next boot.',
        '',
        ...offenders.map((f) => `  ${f}`),
        '',
        'Convert them to LF, for example:',
        `  python -c "import sys;p=sys.argv[1];d=open(p,'rb').read();open(p,'wb').write(d.replace(b'\\r\\n',b'\\n'))" <file>`,
      ].join('\n'),
    );
  }
}
