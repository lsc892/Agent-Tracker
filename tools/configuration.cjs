'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Load the import-free schema before tsc runs; runtime uses its normal compiled module.
function configurationManifest(languages) {
  const filename = path.join(__dirname, '../src/configuration/schema.ts');
  const source = fs.readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  vm.runInThisContext(`(function(exports) { ${compiled.outputText}\n})`, { filename })(exports);
  const { settingCategories, settingDefinitions, mapSettings } = exports;
  const sections = Object.fromEntries(Object.entries(settingCategories).map(([category, metadata]) =>
    [category, { id: `agentTracker.${category}`, ...metadata, properties: {} }]));
  mapSettings(settingDefinitions, (definition, key) => {
    const { category, enumSource, ...property } = definition;
    if (enumSource === 'languages') {
      property.enum = [definition.default, ...languages.map(language => language.locale)];
      property.enumItemLabels = ['%manifest.languageAuto%', ...languages.map(language => language.label)];
    }
    sections[category].properties[`agentTracker.${key}`] = property;
  });
  for (const section of Object.values(sections)) {
    section.properties = Object.fromEntries(Object.entries(section.properties)
      .sort(([, left], [, right]) => (left.order ?? 0) - (right.order ?? 0)));
  }
  return Object.values(sections);
}

module.exports = { configurationManifest };
