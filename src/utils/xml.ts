import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true // 去掉命名空间前缀，类似 C# LocalName 处理
});

export function parseXml<T = any>(xml: string): T {
  return parser.parse(xml) as T;
}
