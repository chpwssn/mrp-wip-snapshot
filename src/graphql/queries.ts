export const GET_RELEASED_JOS = `
  query GetReleasedJOs {
    getJobOrdersWhere(options: { fstatus: "RELEASED" }) {
      fjobno
      fpartno
      fpartrev
      fdescript
      fquantity
      fsono
      fddue_date
      fpriority
      fstatus
      fact_rel
      fopen_dt
    }
  }
`;

export const GET_JODBOM_WITH_POS = `
  query GetJodbomWithPOs($jobOrder: String!) {
    getJodbomsWhere(options: { fjobno: $jobOrder }) {
      fbompart
      fbomrev
      fbomdesc
      fparent
      fparentrev
      factqty
      fpono
      fpoqty
      fqtytopurc
      fqty_iss
      fresponse
      fbomsource
      ftotqty
      fbominum
      jomast {
        fquantity
        fpartno
        fpartrev
      }
      poitem {
        fpono
        fpartno
        frev
        freqdate
        forgpdate
        flstpdate
        fordqty
        frcpqty
        frcpdate
        finvqty
        fvpartno
        fcomments
        PlaceDate
      }
      inmastx {
        fgroup
        fprodcl
        inonhd {
          fonhand
          flocation
          fbinno
        }
      }
    }
  }
`;

// JO routing/work centers (for kitting status)
export const GET_JO_ROUTING = `
  query GetJoRouting($jobOrder: String!) {
    getJobOrdersWhere(options: { fjobno: $jobOrder }) {
      fjobno
      jodrtg {
        foperno
        fpro_id
        fcstat
        fnqty_comp
        fnqty_togo
      }
    }
  }
`;

// System-wide PO lookup for a part (Redbook-style)
export const GET_PO_ITEMS_FOR_PART = `
  query GetPOItemsForPart($partno: String!) {
    getPOItemsWhere(options: { fpartno: $partno }) {
      fpono
      fpartno
      frev
      fjokey
      fsokey
      fcategory
      fordqty
      frcpqty
      freqdate
      flstpdate
      fcomments
      pomast {
        fstatus
        fvendno
        forddate
      }
    }
  }
`;

