const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('../functions/node_modules/@simplewebauthn/server');

const action = process.argv[2];
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    const data = input ? JSON.parse(input) : {};
    if (action === 'generate-registration') {
      const opts = await generateRegistrationOptions({
        rpName: data.rpName || 'Macromix',
        rpID: data.rpId || 'localhost',
        userName: data.userName || data.handle,
        userDisplayName: '@' + (data.userName || data.handle),
        authenticatorSelection: {
          residentKey: 'preferred',
          userVerification: 'preferred',
        },
        attestationType: 'none',
        supportedAlgorithmIDs: [-7, -257],
      });
      process.stdout.write(JSON.stringify({ success: true, options: opts }));
    } else if (action === 'verify-registration') {
      const verification = await verifyRegistrationResponse({
        response: data.attestation,
        expectedChallenge: data.expectedChallenge,
        expectedOrigin: data.expectedOrigin,
        expectedRPID: data.expectedRPID,
        requireUserVerification: false,
      });
      process.stdout.write(JSON.stringify({
        success: verification.verified,
        registrationInfo: verification.registrationInfo ? {
          credentialID: Buffer.from(verification.registrationInfo.credentialID).toString('base64url'),
          credentialPublicKey: Buffer.from(verification.registrationInfo.credentialPublicKey).toString('base64url'),
          counter: verification.registrationInfo.counter
        } : null
      }));
    } else if (action === 'generate-authentication') {
      const opts = await generateAuthenticationOptions({
        rpID: data.rpId || 'localhost',
        allowCredentials: data.allowCredentials || [],
        userVerification: 'preferred',
      });
      process.stdout.write(JSON.stringify({ success: true, options: opts }));
    } else if (action === 'verify-authentication') {
      const verification = await verifyAuthenticationResponse({
        response: data.assertion,
        expectedChallenge: data.expectedChallenge,
        expectedOrigin: data.expectedOrigin,
        expectedRPID: data.expectedRPID,
        requireUserVerification: false,
        credential: {
          id: data.credential.id,
          publicKey: Buffer.from(data.credential.publicKey, 'base64url'),
          counter: data.credential.counter || 0,
        },
      });
      process.stdout.write(JSON.stringify({
        success: verification.verified,
        newCounter: verification.authenticationInfo ? verification.authenticationInfo.newCounter : 0
      }));
    } else {
      process.stderr.write(`Unknown action: ${action}\n`);
      process.exit(1);
    }
  } catch (err) {
    process.stderr.write(err.message + '\n');
    process.exit(1);
  }
});
