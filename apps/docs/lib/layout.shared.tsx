import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, gitConfig } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      // JSX supported
      title: appName,
    },
    links: [
      { text: 'Lifecycle', url: '/lifecycle' },
      { text: 'Failure modes', url: '/failure-modes' },
      { text: 'vs SDLC', url: '/vs-sdlc' },
      { text: 'Toolkit', url: '/toolkit' },
      { text: 'Integrations', url: '/integrations' },
      { text: 'Enterprise', url: '/enterprise' },
      { text: 'Docs', url: '/docs' },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
    // The site is dark-only (dark class forced on <html>, RootProvider theme
    // disabled) — hide the sun/moon toggle so a dead control never ships.
    themeSwitch: { enabled: false },
  };
}
