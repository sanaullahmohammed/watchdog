// https://github.com/cucumber/cucumber-js/blob/main/docs/configuration.md
const config = {
  // Steps and support live under tests/. The boilerplate also required
  // `src/**/*.(!spec).ts`, which was removed with it. That pattern has literal
  // parentheses rather than the extglob `!(spec)`, so Cucumber's own glob
  // matched no file at all and removing it changed nothing. The commit that
  // removed it said the line would have imported every integration suite into
  // Cucumber's process, which was wrong: the extglob form would have, this one
  // could not (Epic 3 retrospective, C-3).
  require: ['cucumber.setup.js', 'tests/**/*.ts'],
  paths: ['tests/**/*.feature'],
  format: [
    'json:reports/cucumber-report.json',
    'html:reports/index.html',
    'summary',
    'progress-bar',
    '@cucumber/pretty-formatter',
  ],
  formatOptions: { snippetInterface: 'async-await' },
};

export default config;
