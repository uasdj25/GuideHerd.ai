import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../_lib/types.js';
import { jsonOk } from '../_lib/types.js';
import { getAccessInfo } from '../_lib/auth.js';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  // Default: no access. getAccessInfo only returns hasAccess=true when
  // a valid session exists AND an active entitlement is confirmed in D1.
  const access = await getAccessInfo(request, env);

  return jsonOk(access, access.hasAccess ? 200 : 200);
};
