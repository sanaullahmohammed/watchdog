import { generateKeyPairSync } from 'node:crypto';
import forge from 'node-forge';

/**
 * A throwaway certificate authority for check suites. Leaves are issued at
 * runtime with chosen SANs and validity, so nothing expires under the repo.
 * RSA keys come from node:crypto; forge only builds and signs the certificates.
 */

export interface IssueOptions {
  dns?: string[];
  ip?: string[];
  notBefore: Date;
  notAfter: Date;
}

export interface TestCa {
  caPem: string;
  issue(options: IssueOptions): { certPem: string; keyPem: string };
}

function newKey(): { privatePem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
  };
}

export function createTestCa(): TestCa {
  const caKey = newKey();
  const caPrivate = forge.pki.privateKeyFromPem(caKey.privatePem);
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = forge.pki.publicKeyFromPem(caKey.publicPem);
  caCert.serialNumber = '01';
  caCert.validity.notBefore = new Date(Date.now() - 365 * 86_400_000);
  caCert.validity.notAfter = new Date(Date.now() + 3650 * 86_400_000);
  const caName = [{ name: 'commonName', value: 'WatchDog Test CA' }];
  caCert.setSubject(caName);
  caCert.setIssuer(caName);
  caCert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true },
  ]);
  caCert.sign(caPrivate, forge.md.sha256.create());

  const leafKey = newKey();
  let serial = 1;
  return {
    caPem: forge.pki.certificateToPem(caCert),
    issue({ dns = [], ip = [], notBefore, notAfter }) {
      const cert = forge.pki.createCertificate();
      cert.publicKey = forge.pki.publicKeyFromPem(leafKey.publicPem);
      serial += 1;
      cert.serialNumber = String(serial).padStart(2, '0');
      cert.validity.notBefore = notBefore;
      cert.validity.notAfter = notAfter;
      cert.setSubject([
        { name: 'commonName', value: dns[0] ?? ip[0] ?? 'leaf' },
      ]);
      cert.setIssuer(caName);
      cert.setExtensions([
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
        {
          name: 'subjectAltName',
          altNames: [
            ...dns.map((value) => ({ type: 2, value })),
            ...ip.map((value) => ({ type: 7, ip: value })),
          ],
        },
      ]);
      cert.sign(caPrivate, forge.md.sha256.create());
      return {
        certPem: forge.pki.certificateToPem(cert),
        keyPem: leafKey.privatePem,
      };
    },
  };
}
