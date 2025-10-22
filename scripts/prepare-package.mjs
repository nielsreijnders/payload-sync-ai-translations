import { promises as fs } from 'node:fs'
import path from 'node:path'

const rootDir = path.resolve(process.cwd())
const distDir = path.join(rootDir, 'dist')
const rootPackagePath = path.join(rootDir, 'package.json')
const distPackagePath = path.join(distDir, 'package.json')

function transformPath(target, condition) {
  if (typeof target !== 'string') return target
  let updated = target.replace(/^\.\/src\//, './')
  if (condition === 'types') {
    updated = updated.replace(/\.[mc]?tsx?$/u, '.d.ts')
  } else {
    updated = updated.replace(/\.[mc]?tsx?$/u, '.js')
  }
  return updated
}

function transformExports(exportsField = {}) {
  const entries = Object.entries(exportsField)
  if (entries.length === 0) {
    return {
      '.': { import: './index.js', types: './index.d.ts', default: './index.js' },
    }
  }
  return Object.fromEntries(
    entries.map(([key, value]) => {
      if (typeof value === 'string') return [key, transformPath(value, 'import')]
      if (value && typeof value === 'object') {
        const transformed = Object.fromEntries(
          Object.entries(value).map(([condition, target]) => [
            condition,
            transformPath(target, condition),
          ]),
        )
        return [key, transformed]
      }
      return [key, value]
    }),
  )
}

async function copyIfExists(src, dest) {
  try {
    await fs.copyFile(src, dest)
  } catch (_) {
    /* ignore */
  }
}

async function main() {
  const raw = await fs.readFile(rootPackagePath, 'utf8')
  const pkg = JSON.parse(raw)

  const distPackage = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    license: pkg.license,
    type: pkg.type || 'module',
    main: './index.js',
    types: './index.d.ts',
    exports: transformExports(pkg.exports),
    peerDependencies: pkg.peerDependencies,
    dependencies: pkg.dependencies,
    engines: pkg.engines,
    repository:
      pkg.repository && pkg.repository.url
        ? pkg.repository
        : {
            type: 'git',
            url: 'https://github.com/nielsreijnders/payload-sync-ai-translations',
          },
    homepage: pkg.homepage,
    bugs: pkg.bugs,
    author: pkg.author,
  }

  await fs.mkdir(distDir, { recursive: true })
  await fs.writeFile(distPackagePath, JSON.stringify(distPackage, null, 2) + '\n', 'utf8')

  await copyIfExists(path.join(rootDir, 'README.md'), path.join(distDir, 'README.md'))
  await copyIfExists(path.join(rootDir, 'LICENSE'), path.join(distDir, 'LICENSE'))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
