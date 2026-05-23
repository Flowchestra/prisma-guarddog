module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'header-max-length': [2, 'always', 120],
    'body-max-line-length': [1, 'always', 120],
    'scope-enum': [
      2,
      'always',
      [
        'core',
        'emitter',
        'importer',
        'testing',
        'lint',
        'preset',
        'cli',
        'docs',
        'examples',
        'build',
        'ci',
        'deps',
        'chore',
        'refactor',
        'test',
        'release',
      ],
    ],
  },
}
