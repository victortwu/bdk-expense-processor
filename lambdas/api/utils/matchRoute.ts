import type { Route } from '../routes'

const decode = (segment: string): string => {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** Match `template` (`/a/{id}/b`) against `path`, returning the captured params or null. */
const matchPath = (template: string, path: string): Record<string, string> | null => {
  const want = template.split('/')
  const got = path.split('/')
  if (want.length !== got.length) return null

  const params: Record<string, string> = {}
  for (let i = 0; i < want.length; i++) {
    const param = want[i].match(/^\{(.+)\}$/)
    if (param) {
      if (!got[i]) return null
      params[param[1]] = decode(got[i])
    } else if (want[i] !== got[i]) {
      return null
    }
  }
  return params
}

/** First route (in table order) matching method + path, with its path parameters. */
export const matchRoute = (
  table: readonly Route[],
  method: string,
  path: string,
): { route: Route; params: Record<string, string> } | null => {
  for (const route of table) {
    if (route.method !== method) continue
    const params = matchPath(route.path, path)
    if (params) return { route, params }
  }
  return null
}
