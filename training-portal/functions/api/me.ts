import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../_lib/types.js';
import { jsonOk } from '../_lib/types.js';
import { getCurrentUser } from '../_lib/auth.js';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const user = await getCurrentUser(request, env);

  if (!user) {
    return jsonOk({ authenticated: false, user: null });
  }

  // Return only safe, non-sensitive fields
  return jsonOk({
    authenticated: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
    },
  });
};
