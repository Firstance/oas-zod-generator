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
