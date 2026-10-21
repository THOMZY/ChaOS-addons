// The Worms browser controller imports the site's modules by URL
// ('/core/js/...'), as the browser does. Under node, map those URLs to the
// site's website/ folder (the add-on is installed in games/worms/).
import { register } from 'node:module';

const website = new URL('../../../website/', import.meta.url).href;
register(
  'data:text/javascript,' +
    encodeURIComponent(`export async function resolve(specifier, context, next) {
  if (specifier.startsWith('/core/')) return next(new URL('.' + specifier, ${JSON.stringify(website)}).href, context);
  return next(specifier, context);
}`),
);
