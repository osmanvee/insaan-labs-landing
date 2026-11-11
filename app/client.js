(function () {
  const { SUPABASE_URL, SUPABASE_KEY } = window.INSAAN_CONFIG;
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  // Returns { email, account } for whoever is signed in, or null.
  // account is null when the email isn't in the accounts table.
  async function currentUser() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return null;
    const email = (session.user.email || '').toLowerCase();
    const { data: row } = await sb.from('accounts').select('name, is_admin').eq('email', email).maybeSingle();
    return {
      email: email,
      account: row ? { email: email, name: row.name, isAdmin: row.is_admin } : null,
    };
  }

  async function signOut() {
    await sb.auth.signOut();
  }

  window.INSAAN = { sb: sb, currentUser: currentUser, signOut: signOut };
})();
