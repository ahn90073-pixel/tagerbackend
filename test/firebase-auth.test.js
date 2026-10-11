import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFirebaseGoogleClaims } from '../src/lib/firebaseAuth.js';

const projectId = 'manger-301';
const validClaims = {
  iss: `https://securetoken.google.com/${projectId}`,
  aud: projectId,
  sub: 'firebase-user-123',
  email: 'Merchant@Example.com',
  email_verified: true,
  name: 'Merchant Name',
  firebase: { sign_in_provider: 'google.com' },
};

test('accepts only verified Google-provider Firebase identity claims', () => {
  assert.deepEqual(validateFirebaseGoogleClaims(validClaims, projectId), {
    uid: 'firebase-user-123',
    email: 'merchant@example.com',
    fullName: 'Merchant Name',
  });
});

test('rejects mismatched Firebase project, provider, email verification, and missing UID', () => {
  assert.equal(validateFirebaseGoogleClaims(validClaims, 'another-project'), null);
  assert.equal(validateFirebaseGoogleClaims({ ...validClaims, aud: 'another-project' }, projectId), null);
  assert.equal(validateFirebaseGoogleClaims({ ...validClaims, email_verified: false }, projectId), null);
  assert.equal(validateFirebaseGoogleClaims({ ...validClaims, firebase: { sign_in_provider: 'password' } }, projectId), null);
  assert.equal(validateFirebaseGoogleClaims({ ...validClaims, sub: '' }, projectId), null);
  assert.equal(validateFirebaseGoogleClaims({ ...validClaims, sub: 'x'.repeat(129) }, projectId), null);
});
