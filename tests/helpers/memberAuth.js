/**
 * Member-app sign-in for tests, along the path a real member takes: the desk
 * issues a temporary password (POST /api/members/:id/app-login, deliver
 * 'show'), and the member signs in with it.
 *
 * `call` is the test file's own fetch wrapper; `opts` is passed through to it
 * (tenant, user agent, ...). The member is named by id; their code comes back
 * from the issue call, so callers don't need it.
 */

async function issueTemporary(call, { staffToken, memberId, ...opts }) {
  const issued = await call('POST', `/api/members/${memberId}/app-login`, { deliver: 'show' }, { ...opts, token: staffToken });
  if (issued.status !== 200) throw new Error(`app-login failed: ${issued.status} ${JSON.stringify(issued.body)}`);
  return { code: issued.body.member.code, password: issued.body.password };
}

async function signIn(call, identifier, password, opts) {
  const login = await call('POST', '/api/portal/login', { identifier, password }, { ...opts, token: null });
  if (login.status !== 200) throw new Error(`portal login failed: ${login.status} ${JSON.stringify(login.body)}`);
  return login.body.token;
}

/** A signed-in member token (still on the temporary password). */
export async function memberToken(call, { staffToken, memberId, ...opts }) {
  const { code, password } = await issueTemporary(call, { staffToken, memberId, ...opts });
  return signIn(call, code, password, opts);
}

/**
 * Gives the member a permanent password and returns it — for tests that sign
 * the same member in more than once, since issuing a temporary password signs
 * out every earlier device.
 */
export async function giveMemberPassword(call, { staffToken, memberId, password = 'member-pass-123', ...opts }) {
  const temp = await issueTemporary(call, { staffToken, memberId, ...opts });
  const token = await signIn(call, temp.code, temp.password, opts);
  const changed = await call(
    'POST',
    '/api/portal/password',
    { current_password: temp.password, new_password: password },
    { ...opts, token },
  );
  if (changed.status !== 200) throw new Error(`password change failed: ${changed.status} ${JSON.stringify(changed.body)}`);
  // Leave no device behind: tests that count sign-ins start from zero.
  await call('DELETE', '/api/portal/sessions/current', undefined, { ...opts, token });
  return password;
}
