import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const escape = key => key.replaceAll('~', '~0').replaceAll('/', '~1');
const tokens = path => path.slice(1).split('/').map(key => key.replaceAll('~1', '/').replaceAll('~0', '~'));
const maps = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies'];
const singles = ['items', 'additionalItems', 'contains', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames', 'not', 'if', 'then', 'else', 'contentSchema'];
const arrays = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];

/** JSON pointers address annotations at schema nodes, including definitions and union branches. */
export function toolTextFields(tool) {
  const fields = [{ path: '/description', location: tool.name, keyword: 'description', defaultText: tool.description }];
  const walk = (node, path, location) => {
    if (!object(node)) return;
    for (const keyword of ['description', 'title']) {
      if (keyword === 'description' || typeof node[keyword] === 'string') {
        fields.push({ path: `${path}/${keyword}`, location, keyword, defaultText: node[keyword] ?? '' });
      }
    }
    for (const keyword of maps) {
      if (object(node[keyword])) for (const [key, child] of Object.entries(node[keyword])) {
        walk(child, `${path}/${keyword}/${escape(key)}`, location === 'parameters' && keyword === 'properties' ? key : `${location}.${keyword}.${key}`);
      }
    }
    for (const keyword of singles) walk(node[keyword], `${path}/${keyword}`, `${location}.${keyword}`);
    for (const keyword of [...arrays, 'items']) {
      if (Array.isArray(node[keyword])) node[keyword].forEach((child, index) => walk(child, `${path}/${keyword}/${index}`, `${location}.${keyword}[${index}]`));
    }
  };
  walk(tool.parameters, '/parameters', 'parameters');
  return fields;
}

function setText(tool, path, value) {
  const keys = tokens(path), key = keys.pop();
  let node = tool;
  for (const segment of keys) node = node[segment];
  node[key] = value;
}

function readLayer(path) {
  if (!path || !existsSync(path)) return { raw: '', tools: {} };
  const raw = readFileSync(path, 'utf8');
  try {
    const data = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (data.version !== 1 || !object(data.tools) || !Object.values(data.tools).every(fields => object(fields) && Object.values(fields).every(text => typeof text === 'string'))) {
      throw new Error('Expected version 1 and a tools object containing text overrides.');
    }
    return { raw, tools: data.tools };
  } catch (error) { return { raw, tools: {}, error: error.message }; }
}

/** Package defaults remain immutable. Only deployment overrides are written. */
export class ToolTextStore {
  constructor(tools, { botDir, packageDir, id }) {
    this.defaults = tools;
    this.fields = new Map(tools.map(tool => [tool.name, new Map(toolTextFields(tool).map(field => [field.path, field]))]));
    this.path = botDir ? join(botDir, 'worlds', id, 'tool-text.json') : null;
    this.packagePath = packageDir ? join(packageDir, 'worlds', id, 'tool-text.json') : null;
  }

  read() {
    const inherited = readLayer(this.packagePath), deployment = readLayer(this.path), warnings = [];
    // JSON cloning also separates schema nodes shared by several tool declarations.
    const tools = JSON.parse(JSON.stringify(this.defaults));
    for (const [layer, data] of [['package', inherited], ['deployment', deployment]]) {
      if (data.error) warnings.push({ layer, error: data.error });
      for (const [name, changes] of Object.entries(data.tools)) for (const [path, text] of Object.entries(changes)) {
        if (!this.fields.get(name)?.has(path)) { warnings.push({ layer, tool: name, path }); continue; }
        setText(tools.find(tool => tool.name === name), path, text);
      }
    }
    return {
      revision: createHash('sha256').update(JSON.stringify([this.defaults, inherited.raw, deployment.raw])).digest('hex'),
      overrides: deployment.tools,
      warnings,
      tools: tools.map(tool => ({ ...tool, fields: [...this.fields.get(tool.name).values()].map(field => {
        const inheritedText = inherited.tools[tool.name]?.[field.path] ?? field.defaultText;
        const overridden = Object.hasOwn(deployment.tools[tool.name] ?? {}, field.path);
        const inheritedSource = Object.hasOwn(inherited.tools[tool.name] ?? {}, field.path) ? 'package' : 'default';
        return { ...field, inheritedText, inheritedSource, text: deployment.tools[tool.name]?.[field.path] ?? inheritedText, source: overridden ? 'deployment' : inheritedSource };
      }) })),
    };
  }

  resolve() { return this.read().tools.map(({ fields, ...tool }) => tool); }

  current(expectedRevision) {
    if (!this.path) throw new Error('The deployment directory is unavailable.');
    const current = this.read();
    if (expectedRevision !== current.revision) throw new Error('Tool text changed. Refresh before saving.');
    return current;
  }

  save({ expectedRevision, overrides }) {
    const current = this.current(expectedRevision);
    if (current.warnings.some(warning => warning.layer === 'deployment' && warning.error)) throw new Error('The override file is invalid. Restore defaults before saving.');
    if (!object(overrides)) throw new Error('Expected a tools object containing text overrides.');
    const next = {};
    for (const [name, changes] of Object.entries(overrides)) {
      if (!object(changes)) throw new Error(`Invalid text overrides for ${name}.`);
      const fields = new Map(current.tools.find(tool => tool.name === name)?.fields.map(field => [field.path, field]) ?? []);
      const entries = [];
      for (const [path, text] of Object.entries(changes)) {
        if (typeof text !== 'string') throw new Error(`Expected text at ${name}${path}.`);
        const field = fields.get(path);
        if (!field) {
          if (!Object.hasOwn(current.overrides[name] ?? {}, path) || current.overrides[name][path] !== text) throw new Error(`Unknown tool text field: ${name}${path}.`);
        } else if (text === field.inheritedText) continue;
        entries.push([path, text]);
      }
      if (entries.length) Object.defineProperty(next, name, { value: Object.fromEntries(entries), enumerable: true });
    }
    if (Object.keys(next).length) {
      mkdirSync(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temp, JSON.stringify({ version: 1, tools: next }, null, 2) + '\n', { flag: 'wx' });
        renameSync(temp, this.path);
      } finally { rmSync(temp, { force: true }); }
    } else rmSync(this.path, { force: true });
    return this.read();
  }

  reset({ expectedRevision }) {
    this.current(expectedRevision);
    rmSync(this.path, { force: true });
    return this.read();
  }
}
