export interface GqlPoitem {
  fpono: string;
  fpartno: string;
  frev: string;
  freqdate: string | null;
  forgpdate: string | null;
  flstpdate: string | null;
  fordqty: number;
  frcpqty: number;
  frcpdate: string | null;
  finvqty: number;
  fvpartno: string;
  fcomments: string;
  PlaceDate: string | null;
}

export interface GqlJomast {
  fjobno: string;
  fpartno: string;
  fpartrev: string;
  fdescript: string;
  fquantity: number;
  fsono: string;
  fddue_date: string | null;
  fpriority: string;
  fstatus: string;
  fact_rel: string | null;
  fopen_dt: string | null;
}

export interface GqlJodbomInmastx {
  fgroup: string;
  fprodcl: string;
  inonhd: GqlInonhd[] | null;
}

export interface GqlJodbom {
  fbompart: string;
  fbomrev: string;
  fbomdesc: string;
  fparent: string;
  fparentrev: string;
  factqty: number;
  fpono: string;
  fpoqty: number;
  fqtytopurc: number;
  fqty_iss: number;
  fresponse: string;
  fbomsource: string;
  ftotqty: number;
  fbominum: string;
  poitem: GqlPoitem[] | null;
  jomast: GqlJomast | null;
  inmastx: GqlJodbomInmastx | null;
}

export interface GqlPomast {
  fstatus: string;
  fvendno: string;
  forddate: string | null;
}

export interface GqlPoitemFull {
  fpono: string;
  fpartno: string;
  frev: string;
  fjokey: string;
  fsokey: string;
  fcategory: string;
  fordqty: number;
  frcpqty: number;
  freqdate: string | null;
  flstpdate: string | null;
  fcomments: string;
  pomast: GqlPomast | null;
}

export interface GqlInonhd {
  fonhand: number;
  flocation: string;
  fbinno: string;
}

export interface GqlPartWithOnhand {
  fpartno: string;
  fdescript: string;
  inonhd: GqlInonhd[] | null;
}

export interface GqlPoItemsForPartResponse {
  getPOItemsWhere: GqlPoitemFull[];
}

export interface GqlPartWithOnhandResponse {
  getPartsWhere: GqlPartWithOnhand[];
}

export interface GqlShopSupplyPart {
  fpartno: string;
  fgroup: string;
  fprodcl: string;
  fdescript: string;
}

export interface GqlShopSupplyResponse {
  byGroup: GqlShopSupplyPart[];
  byProdcl: GqlShopSupplyPart[];
}

export interface GqlJobOrdersResponse {
  getJobOrdersWhere?: GqlJomast[];
  getJobOrdersLike?: GqlJomast[];
}

export interface GqlJodbomResponse {
  getJodbomsWhere: GqlJodbom[];
}
