#!/usr/bin/env node

import packageJson from './../package.json';

import {promises as fs} from 'fs';
import {Resolver} from '@stoplight/json-ref-resolver';
import {JSONPath} from 'jsonpath-plus';
import {z} from 'zod';
import {parseSchema} from 'json-schema-to-zod';
import assert from 'node:assert';
import path from 'node:path';
import {Command} from 'commander';

const DISCLAIMER = `This file has been generated by ${packageJson.name}, do not modify it`;

const TYPES = `
// ${DISCLAIMER}

export type Request = {
  pathParameters: Record<string, string | undefined>;
  queryParameters: Record<string, string | undefined>;
  body?: any;
};

export type Response = {
  statusCode: number;
  contentType: string;
  body: any;
};
`;

const hasField = <T extends {[K in F]?: T[K]}, F extends keyof T & string>(
  o: T,
  f: F,
): o is T & {[K in F]: NonNullable<T[K]>} => {
  if (!o[f]) false;
  return true;
};

type KeysOf<T extends Object> = T extends Record<infer K, infer _V>
  ? K[]
  : T extends Partial<infer Y extends Object>
  ? KeysOf<Y>
  : string[];

const keys = <T extends Object, R = KeysOf<T>>(o: T): R => {
  return Object.keys(o) as R;
};

const statusCodeValidatorFrom = (statusCodeOAS: string): string => {
  if (statusCodeOAS.includes('X')) {
    const min = parseInt(statusCodeOAS.replace(/X/g, '0'), 10);
    const max = parseInt(statusCodeOAS.replace(/X/g, '9'), 10);
    return `z.number().gte(${min}).lte(${max})`;
  }
  return `z.literal(${parseInt(statusCodeOAS)})`;
};

const parametersInSchema = z.union([z.literal('path'), z.literal('query')]);

const parametersSchemaOAS = z.array(
  z.object({
    name: z.string(),
    in: parametersInSchema,
    required: z.boolean(),
    schema: z.any(),
  }),
);

const requestsSelectorSchemaOAS = z.record(
  z.string(),
  z.record(
    z.union([
      z.literal('get'),
      z.literal('post'),
      z.literal('head'),
      z.literal('options'),
      z.literal('put'),
      z.literal('delete'),
      z.literal('patch'),
      z.literal('trace'),
    ]),
    z.object({
      operationId: z.string().optional(),
    }),
  ),
);

type ParametersIn = z.infer<typeof parametersInSchema>;

// TODO rename as OASSchema
const requestBodySchemaOAS = z.object({
  required: z.boolean(),
  content: z.record(
    z.string(), // content type
    z.object({
      schema: z.any(),
    }),
  ),
});

const responsesSchemaOAS = z.record(
  z.string(),
  z.object({
    content: z.record(
      z.string(), // content type
      z.object({
        schema: z.any(),
      }),
    ),
  }),
);

type RequestSelector = {
  path: string;
  method: string;
  id: string | null;
};

const requestValidator = (
  oas: Record<string, unknown>,
  selector: RequestSelector,
): string => {
  const pathJ = `paths[${selector.path}].${selector.method.toLowerCase()}`;
  const requestJ = JSONPath({
    path: pathJ,
    json: oas,
    flatten: true,
  });
  if (requestJ.length !== 1) {
    throw new Error(
      `found ${requestJ.length} element at ${pathJ} in OAS file, expected 1`,
    );
  }

  const pathValidator = parametersValidatorIn(requestJ[0], 'path');
  const queryValidator = parametersValidatorIn(requestJ[0], 'query');
  const bodyValidator = requestBodyValidatorIn(requestJ[0]);

  let moduleS = `// ${DISCLAIMER}\n\n`;
  moduleS += `import { z } from "zod"\n\n`;
  moduleS += `export default z.object({\n`;
  moduleS += `  pathParameters: ${pathValidator},\n`;
  moduleS += `  queryParameters: ${queryValidator},\n`;
  moduleS += `  body: ${bodyValidator},\n`;
  moduleS += '})';

  return moduleS;
};

const parametersValidatorIn = (
  oas: Record<string, unknown>,
  where: ParametersIn,
): string => {
  if (!('parameters' in oas)) {
    return 'z.object({})';
  }

  const parametersP = parametersSchemaOAS.safeParse(oas['parameters']);
  if (!parametersP.success) {
    throw new Error(
      'unexpected values in request parameters specification.\n' +
        JSON.stringify(parametersP.error.issues),
    );
  }
  const parametersR = parametersP.data;

  let validator = `z.object({`;
  parametersR.forEach(p => {
    if (p.in !== where) return;
    if (p.required) {
      validator += `  "${p.name}": ${parseSchema(p.schema)},\n`;
    } else {
      validator += `  "${p.name}": ${parseSchema(p.schema)}.optional(),\n`;
    }
  });
  validator += '})';

  return validator;
};

const requestBodyValidatorIn = (oas: Record<string, unknown>): string => {
  if (!('requestBody' in oas)) {
    return 'z.any()';
  }

  const requestBodyP = requestBodySchemaOAS.safeParse(oas['requestBody']);
  if (!requestBodyP.success) {
    throw new Error(
      'unexpected values in request body specification.\n' +
        JSON.stringify(requestBodyP.error.issues),
    );
  }
  const requestBodyR = requestBodyP.data;

  // TODO: handle required false
  // TODO: handle contentType false

  const contentTypes = Object.keys(requestBodyR.content);
  assert(contentTypes.length === 1);
  const contentType = contentTypes[0];
  assert(requestBodyR.content[contentType]);
  const requestBodyS = requestBodyR.content[contentType];
  assert(requestBodyS);

  return parseSchema(requestBodyS.schema);
};

const responsesValidator = (
  oas: Record<string, unknown>,
  selector: RequestSelector,
): string => {
  const pathJ = `paths[${
    selector.path
  }].${selector.method.toLowerCase()}.responses`;
  const responsesJ = JSONPath({
    path: pathJ,
    json: oas,
    flatten: true,
  });

  if (responsesJ.length !== 1) {
    throw new Error(
      `found ${responsesJ.length} element at ${pathJ} in OAS file, expected 1`,
    );
  }

  const responsesP = responsesSchemaOAS.safeParse(responsesJ[0]);
  if (!responsesP.success) {
    throw new Error(
      'unexpected values in responses specification.\n' +
        JSON.stringify(responsesP.error.issues),
    );
  }
  const responsesR = responsesP.data;

  // TODO: library to write TypeScript or algebraically formatting?
  let responseNames: string[] = [];
  let moduleS = `// ${DISCLAIMER}\n\n`;
  moduleS += `import { z } from "zod"\n\n`;
  Object.keys(responsesR).forEach(statusCode => {
    moduleS += `export const response${statusCode}Schema = z.object({\n`;
    moduleS += `  statusCode: ${statusCodeValidatorFrom(statusCode)},\n`;

    const contentTypes = Object.keys(responsesR[statusCode].content);
    assert(contentTypes.length === 1);
    const contentType = contentTypes[0];
    assert(responsesR[statusCode].content[contentType]);
    const responseBody = responsesR[statusCode].content[contentType];
    assert(responseBody);

    moduleS += `  contentType: z.literal('${contentType}'),\n`;
    moduleS += `  body: ${parseSchema(
      responsesR[statusCode].content[contentType].schema,
    )},\n`;
    moduleS += '});\n';
    // moduleS += `export response${statusCode}Schema;\n\n`;
    responseNames.push(`response${statusCode}Schema`);
  });
  if (responseNames.length > 1) {
    return (
      moduleS + `export default z.union([` + responseNames.join(', ') + ']);\n'
    );
  }
  if (responseNames.length > 0) {
    return moduleS + `export default ${responseNames[0]};\n`;
  }
  return moduleS + `export default z.any();\n`;
};

const allRequestSelectors = (oas: any): RequestSelector[] => {
  if (!('paths' in oas)) {
    throw new Error('no requests found in OAS file');
  }

  const requestsP = requestsSelectorSchemaOAS.safeParse(oas.paths);
  if (!requestsP.success) {
    throw new Error(
      'unexpected values in request specification.\n' +
        JSON.stringify(requestsP.error.issues),
    );
  }
  const requestsR = requestsP.data;

  return keys(requestsR)
    .map(path => {
      return keys(requestsR[path]).map(method => {
        const requestR = requestsR[path][method];
        assert(requestR);
        if (hasField(requestR, 'operationId')) {
          return {
            path,
            method,
            id: requestR.operationId || null,
          };
        }
        return {
          path,
          method,
          id: null,
        };
      });
    })
    .flat();
};

const normalizeName = (rs: RequestSelector): string => {
  // if (rs.id) return rs.id;
  // TODO: is it reliable?
  // it's something like:
  //   fa-api-user-dev-getAll
  //   fa-api-user-dev-getOne
  //   fa-api-user-dev-createOne

  const tokens = rs.path.slice(1).split('/');
  return (
    tokens
      .slice(0, 1)
      .concat(
        tokens.slice(1).map(t => {
          const matches = t.match(/^\{(.*)\}$/);
          if (matches) {
            return matches[1].toUpperCase();
          }
          return t.slice(0, 1).toUpperCase() + t.slice(1);
        }),
      )
      .join('') +
    '.' +
    rs.method
  );
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    const file = await fs.stat(filePath);
    return file.isFile();
  } catch {
    return false;
  }
};

const directoryExists = async (dirPath: string): Promise<boolean> => {
  try {
    const dir = await fs.stat(dirPath);
    return dir.isDirectory();
  } catch {
    return false;
  }
};

const ensureOutputDirectory = async (dirPath: string): Promise<void> => {
  try {
    if (!(await directoryExists(dirPath))) {
      await fs.mkdir(dirPath, {
        recursive: true,
        mode: 0o777,
      });
    }
    await fs.access(dirPath, fs.constants.W_OK);
  } catch (_) {
    throw new Error(
      `cannot create or access directory ${dirPath}, check your permissions`,
    );
  }
};

const ensureInputFile = async (filePath: string): Promise<void> => {
  if (!(await fileExists(filePath))) {
    throw new Error(`file ${filePath}, do not exists`);
  }
  try {
    await fs.access(filePath, fs.constants.W_OK);
  } catch (_) {
    throw new Error(`cannot access file ${filePath}, check your permissions`);
  }
};

const writeFile = async (
  dirPath: string,
  fileName: string,
  content: string,
  overwrite: boolean,
): Promise<void> => {
  const filePath = path.join(dirPath, fileName);
  if ((await fileExists(filePath)) && !overwrite) {
    throw new Error(
      `file ${filePath} already exists, please use flag --overwrite if that's your intention`,
    );
  }
  await fs.writeFile(filePath, content, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'w+',
  });
};

const normalizePath = (pathIn: string): string => {
  if (path.isAbsolute(pathIn)) {
    return pathIn;
  }
  return path.resolve(process.cwd(), pathIn);
};

const generate = async (
  oasPath: string,
  outPath: string,
  overwrite: boolean,
) => {
  await ensureInputFile(oasPath);
  await ensureOutputDirectory(outPath);

  const content = await fs.readFile(oasPath, 'utf8');
  const oasF = JSON.parse(content.toString());
  const oasR = await new Resolver().resolve(oasF);

  if (oasR.errors.length > 0) {
    throw new Error(
      'unable to resolve references in OAS json.\n' +
        JSON.stringify(oasR.errors),
    );
  }

  allRequestSelectors(oasR.result).forEach(async requestSelector => {
    const requestName = normalizeName(requestSelector);

    const requestValidatorModule = requestValidator(
      oasR.result,
      requestSelector,
    );
    if (requestValidatorModule === null) {
      throw new Error(
        `failed to generate validators for request of ${requestName}`,
      );
    }

    const responsesValidatorModule = responsesValidator(
      oasR.result,
      requestSelector,
    );
    if (responsesValidatorModule === null) {
      throw new Error(
        `failed to generate validators for responses of ${requestName}`,
      );
    }

    await writeFile(
      outPath,
      `${requestName}.requestValidator.ts`,
      requestValidatorModule,
      overwrite,
    );
    await writeFile(
      outPath,
      `${requestName}.responsesValidator.ts`,
      responsesValidatorModule,
      overwrite,
    );
  });
  await writeFile(outPath, 'types.ts', TYPES, overwrite);
};

const main = async (oasPath: string, outPath: string, overwrite: boolean) => {
  try {
    await generate(oasPath, outPath, overwrite);
    const relativeOutPath = path.relative(process.cwd(), outPath);
    console.log(`OK: everything was generated in ${relativeOutPath}\n`);
  } catch (e) {
    if (e instanceof Error) {
      console.error('ERROR: ' + e.message + '\n');
    } else {
      console.error(e);
    }
    process.exit(1);
  }
};

const program = new Command();

program
  .name(packageJson.name)
  .description(packageJson.description)
  .version(packageJson.version)
  .option('--overwrite', 'overwrite existing files if any')
  .option('-i, --input <path>', 'OAS specification file')
  .option('-o, --output <path>', 'output directory where to put generate files')
  .parse();

const options = program.opts();
if (!options.input || !options.output) {
  program.help();
}

main(
  normalizePath(options.input),
  normalizePath(options.output),
  options.overwrite || false,
);
