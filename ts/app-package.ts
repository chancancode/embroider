import { Memoize } from 'typescript-memoize';
import { dirname } from 'path';
import { sync as pkgUpSync }  from 'pkg-up';
import { WatchedDir } from 'broccoli-source';
import DependencyAnalyzer from './dependency-analyzer';
import RewritePackageJSON from './rewrite-package-json';
import { join } from 'path';
import resolve from 'resolve';
import Funnel from 'broccoli-funnel';
import mergeTrees from 'broccoli-merge-trees';
import AppEntrypoint from './app-entrypoint';
import AddonPackage from './addon-package';
import { todo } from './messages';
import { trackedImportTree } from './tracked-imports';
import quickTemp from 'quick-temp';
import { updateBabelConfig } from './babel-config';
import { Tree } from 'broccoli-plugin';
import ImportParser from './import-parser';
import V1InstanceCache from './v1-instance-cache';
import flatten from 'lodash/flatten';
import V1App from './v1-app';

export default class AppPackage {
  private app; // : V1App;

  constructor(root: string, private v1Cache: V1InstanceCache ) {
    this.app = (v1Cache.getApp(root) as any).app;
  }

  get tree(): Tree {
    let trees = this.v2Trees();
    return new Funnel(mergeTrees(trees), {
      destDir: this.name
    });
  }

  get name() : string {
    return this.app.project.pkg.name;
  }

  private get options() {
    return this.app.options;
  }

  hasAnyTrees() {
    return true;
  }

  private transpile(tree) {
    this.updateBabelConfig();
    return this.preprocessors.preprocessJs(tree, '/', '/', { registry: this.app.registry });
  }

  @Memoize()
  private updateBabelConfig() {
    updateBabelConfig(this.name, this.options, this.app.project.addons.find(a => a.name === 'ember-cli-babel'));
  }

  private parseImports(tree) {
    return new ImportParser(tree);
  }

  private v2Trees() {
    let inputTrees = this.app.trees;
    let trees = [];
    let importParsers = [];
    let appTree;

    {
      quickTemp.makeOrRemake(this, 'trackedImportDir');
      let tree = trackedImportTree(this.name, this.app._trackedImports, (this as any).trackedImportDir);
      if (tree) {
        trees.push(tree);
      }
    }
    if (inputTrees.app) {
      appTree = this.transpile(inputTrees.app);
      importParsers.push(this.parseImports(appTree));
      trees.push(appTree);
    }

    trees.push(this.htmlTree);
    trees.push(new AppEntrypoint(appTree, { appPackage: this, outputPath: `assets/${this.name}.js` }));

    todo('more trees: src, tests, styles, templates, bower, vendor, public');

    let analyzer = new DependencyAnalyzer(importParsers, this.app.project.pkg, true );
    trees.push(new RewritePackageJSON(this.rootTree, analyzer));

    return trees;
  }

  @Memoize()
  private get isModuleUnification() {
    let experiments = this.requireFromEmberCLI('./lib/experiments');
    return experiments.MODULE_UNIFICATION && !!this.app.trees.src;
  }

  @Memoize()
  private get emberCLILocation() {
    return dirname(resolve.sync('ember-cli/package.json', { basedir: this.root }));
  }

  private requireFromEmberCLI(specifier) {
    return require(resolve.sync(specifier, { basedir: this.emberCLILocation }));
  }

  private get configReplace() {
    return this.requireFromEmberCLI('broccoli-config-replace');
  }

  private get configLoader() {
    return this.requireFromEmberCLI('broccoli-config-loader');
  }

  private get appUtils() {
    return this.requireFromEmberCLI('./lib/utilities/ember-app-utils');
  }

  @Memoize()
  private get preprocessors() {
    return this.requireFromEmberCLI('ember-cli-preprocess-registry/preprocessors');
  }

  private get configTree() {
    return new (this.configLoader)(dirname(this.app.project.configPath()), {
      env: this.app.env,
      tests: this.app.tests || false,
      project: this.app.project,
    });
  }

  private get htmlTree() {
    let indexFilePath = this.options.outputPaths.app.html;

    let index = new Funnel(this.rootTree, {
      allowEmtpy: true,
      include: [`app/index.html`],
      getDestinationPath: () => indexFilePath,
      annotation: 'app/index.html',
    });

    if (this.isModuleUnification) {
      let srcIndex = new Funnel(this.rootTree, {
        files: ['src/ui/index.html'],
        getDestinationPath: () => indexFilePath,
        annotation: 'src/ui/index.html',
      });

      index = mergeTrees([
        index,
        srcIndex,
      ], {
        overwrite: true,
        annotation: 'merge classic and MU index.html'
      });
    }

    let patterns = this.appUtils.configReplacePatterns({
      addons: this.app.project.addons,
      autoRun: this.options.autoRun,
      storeConfigInMeta: this.options.storeConfigInMeta,
      isModuleUnification: this.isModuleUnification
    });

    return new (this.configReplace)(index, this.configTree, {
      configPath: join('environments', `${this.app.env}.json`),
      files: [indexFilePath],
      patterns,
    });
  }

  @Memoize()
  private get root(): string {
    return dirname(pkgUpSync(this.app.root));
  }

  @Memoize()
  private get rootTree() {
    return new WatchedDir(this.root);
  }

  // TODO: This is a placeholder for development purposes only.
  dumpTrees() {
    let pkgs = flatten([...(this.v1Cache as any).addons.values()]).map(v1Addon => new AddonPackage((v1Addon as any).addon));
    (pkgs as any).unshift(this);
    return pkgs.map((pkg, index) => new Funnel(pkg.tree, { destDir: `out-${index}` }));
  }

}
