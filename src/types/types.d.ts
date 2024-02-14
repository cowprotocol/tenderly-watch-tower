/* eslint-disable */
/**
 * This file was automatically generated by json-schema-to-typescript.
 * DO NOT MODIFY IT BY HAND. Instead, modify the source JSONSchema file,
 * and run json-schema-to-typescript to regenerate this file.
 */

export type FilterAction = "ACCEPT" | "DROP" | "SKIP";

export interface Config {
  networks: {
    name: string;
    rpc: string;
    deploymentBlock: number;
    watchdogTimeout?: number;
    orderBookApi?: string;
    pageSize?: number;
    filterPolicy: {
      defaultAction: FilterAction;
      owners?: {
        [k: string]: FilterAction;
      };
      handlers?: {
        [k: string]: FilterAction;
      };
      transactions?: {
        [k: string]: FilterAction;
      };
      conditionalOrderIds?: {
        [k: string]: FilterAction;
      };
    };
  }[];
}
