# OAS Zod Generator

Generates Zod validators from Open API Specifications

## Why

When you have good specifications you want your code to stick to them.

## What

Given an [Open API Specification](https://spec.openapis.org/oas/v3.0.3) file in
JSON format, this tool will generate [Zod](https://zod.dev/) schema validators
for each request and their corresponding responses.

For each request a file will be created with its validator and another file for
all corresponding responses with its validator. The rationale is that you want
to validate the incoming request and validate your response which can be one of
the possible responses given the request.

File names are generated uniquely given the characteristics of the request.

## How

```shell
$ npx oas-zod-generator --input oasfile.json --output src/.validators --overwrite
```

This will generate a bunch of files in `src/.validators`.

You should be able to recognize which file contains which validator of which
request/responses by its name.

To be able to validate an HTTP request the request must be put into a form known
by validators, you can find this type declared in `src/.validators/types.ts`.

Therefore, what you need to do is:

- Import the appropriate validator
- Create a representation of the request/response compatible with the declared
  in `src/.validators/types.ts`
- Use the validators

Here's a little example of what may look like

```typescript
import validator from './validators/userGetOne.requestValidator';
import {Request} from './validators/types';

// transform your request to the request to validate by picking
// path parameters, query parameters and the parsed body
const request: Request = ...;

const rv = validator.safeParse(request)
if (!rv.success) {
  // report validator error
}

// ejoy your type safe request
const r = rv.data;
```

## Install

```shell
npm install --save-dev https://github.com/firstance/oas-zod-generator
```

## Limitations

Known limitations:

- Open API Specification supported versions: 3.0.3, 3.1.0
- Support validation of request body only if content type is JSON
- Support validation of response body only if content type is JSON

## Improvements

- [ ] Add cli reporting
- [ ] Handle `required` flag for request body (in given OAS file is always set
      to `true`, therefore is not considered for now)
- [ ] More tests
- [ ] Headers validation for requests (not sure if wanted or worth it)
- [ ] Headers validation for responses (not sure if wanted or worth it)
- [ ] Support Zod transformers for query/path parameters
