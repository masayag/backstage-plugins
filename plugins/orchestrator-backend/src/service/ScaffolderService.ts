import { UrlReader } from '@backstage/backend-common';
import { CatalogApi } from '@backstage/catalog-client';
import { Config } from '@backstage/config';
import { ScmIntegrations } from '@backstage/integration';
import {
  createBuiltinActions,
  TemplateActionRegistry,
} from '@backstage/plugin-scaffolder-backend';
import {
  ActionContext,
  TemplateAction,
} from '@backstage/plugin-scaffolder-node';
import { JsonObject, JsonValue } from '@backstage/types';

import fs from 'fs-extra';
import { Logger } from 'winston';

import { randomUUID } from 'crypto';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';

export interface ActionExecutionContext {
  actionId: string;
  instanceId: string | undefined;
  input: JsonObject;
}

export class ScaffolderService {
  private actionRegistry: TemplateActionRegistry;
  private streamLogger = new PassThrough();

  constructor(
    private readonly logger: Logger,
    private readonly config: Config,
    private readonly catalogApi: CatalogApi,
    private readonly urlReader: UrlReader,
  ) {
    this.actionRegistry = new TemplateActionRegistry();
  }

  public loadActions(): void {
    const actions = [
      ...createBuiltinActions({
        integrations: ScmIntegrations.fromConfig(this.config),
        catalogClient: this.catalogApi,
        reader: this.urlReader,
        config: this.config,
      }),
    ];
    actions.forEach(a => this.actionRegistry.register(a));
  }

  public getAction(id: string): TemplateAction {
    return this.actionRegistry.get(id);
  }

  public async executeAction(
    actionExecutionContext: ActionExecutionContext,
  ): Promise<JsonValue> {
    if (this.actionRegistry.list().length === 0) {
      this.loadActions();
    }

    const action: TemplateAction = this.getAction(
      actionExecutionContext.actionId,
    );
    const tmpDirs: string[] = new Array<string>();
    const stepOutput: { [outputName: string]: JsonValue } = {};
    const workingDirectory: string = await this.getWorkingDirectory(
      this.config,
      this.logger,
    );
    const workspacePath: string = path.join(
      workingDirectory,
      actionExecutionContext.instanceId ?? randomUUID(),
    );
    const mockContext: ActionContext<JsonObject> = {
      input: actionExecutionContext.input,
      workspacePath: workspacePath,
      logger: this.logger,
      logStream: this.streamLogger,
      createTemporaryDirectory: async () => {
        const tmpDir = await fs.mkdtemp(`${workspacePath}_step-${0}-`);
        tmpDirs.push(tmpDir);
        return tmpDir;
      },
      output(name: string, value: JsonValue) {
        stepOutput[name] = value;
      },
    };
    await action.handler(mockContext);

    // TODO Not sure if we need these "long lived" for the duration of the whole Workflow
    // Remove all temporary directories that were created when executing the action
    // for (const tmpDir of tmpDirs) {
    //   await fs.remove(tmpDir);
    // }
    return stepOutput;
  }

  async getWorkingDirectory(config: Config, logger: Logger): Promise<string> {
    if (!config.has('backend.workingDirectory')) {
      return os.tmpdir();
    }

    const workingDirectory = config.getString('backend.workingDirectory');
    try {
      // Check if working directory exists and is writable
      await fs.access(workingDirectory, fs.constants.F_OK | fs.constants.W_OK);
      logger.info(`using working directory: ${workingDirectory}`);
    } catch (err: any) {
      logger.error(
        `working directory ${workingDirectory} ${
          err.code === 'ENOENT' ? 'does not exist' : 'is not writable'
        }`,
      );
      throw err;
    }
    return workingDirectory;
  }
}
