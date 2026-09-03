export type ExportDataType = "number" | "string" | "datetime" | "boolean" | "unknown";

export type EnumValue = {
  value: string;
  description: string;
  descriptionEn: string;
  aliases: string[];
};

export type ColumnAnnotation = {
  included: boolean;
  entityColumn: string;
  aliases: string[];
  detailedDescription: string;
  isLocalId: boolean;
  isDisplayName: boolean;
  isSemantic: boolean;
  isCode: boolean;
  enumValues: EnumValue[];
  enumRef: string;
  enumDescription: string;
};

export type Column = {
  name: string;
  description: string;
  dataType: string;
  length: string;
  isPrimaryKey: boolean;
  nullable: boolean;
  remark: string;
  annotation?: ColumnAnnotation;
};

export type ColumnMapping = {
  parentColumn: string;
  childColumn: string;
};

export type Relationship = {
  name: string;
  parentTable: string;
  childTable: string;
  cardinality: string;
  cardinalityRaw: string;
  deleteConstraint: string;
  updateConstraint: string;
  constraintName: string;
  columnMapping: ColumnMapping[];
};

export type SchemaTable = {
  tableName: string;
  className: string;
  classDescription: string;
  classAliases: string[];
  description: string;
  folder: string;
  domain0: string;
  domain1: string;
  columns: Column[];
  foreignKeys: Relationship[];
  referencedBy: Relationship[];
};

export const UNCLASSIFIED = "未归类";
export const ROOT_FOLDER = "根目录";

export const pePlanPolicyJson = {
  tableName: "PE_PLAN_POLICY",
  description: "计划策略是对策略实例化数据，包括填写策略周期信息、策略扩展属性、策略中的模式和动作数据、策略参数实例化。",
  folder: "04 Plan(计划)",
  columns: [
    {
      name: "PLAN_POLICY_ID",
      description: "计划策略标识",
      dataType: "NUMBER(20)",
      length: "20",
      isPrimaryKey: true,
      nullable: false,
      remark: "计划策略标识。唯一标识一个计划策略，由序列器自动生成。",
    },
    {
      name: "PLAN_POLICY_NAME",
      description: "计划策略名称",
      dataType: "VARCHAR2(128)",
      length: "128",
      isPrimaryKey: false,
      nullable: false,
      remark: "计划策略的短名称。",
    },
    {
      name: "PLAN_VERSION_ID",
      description: "计划版本标识",
      dataType: "NUMBER(20)",
      length: "20",
      isPrimaryKey: false,
      nullable: true,
      remark: "计划策略所属的版本的标识，是plan下的一个具体的版本标识。",
    },
    {
      name: "POLICY_ID",
      description: "策略标识",
      dataType: "NUMBER(20)",
      length: "20",
      isPrimaryKey: false,
      nullable: false,
      remark: "策略标识。用来描述计划策略所引用的具体策略的ID。",
    },
    {
      name: "PLAN_POLICY_CYCLE_ID",
      description: "策略周期标识",
      dataType: "NUMBER(20)",
      length: "20",
      isPrimaryKey: false,
      nullable: true,
      remark: "策略周期标识。计划在对策略实例化时可以覆盖策略上定义的策略周期。如果权限上不允许，则直接将数据拷贝一份过来，这样计费帐务后台直接去计划策略上的周期，而不用关注策略定义上的周期。",
    },
    {
      name: "EXECUTE_PRIORITY",
      description: "执行顺序",
      dataType: "NUMBER(10)",
      length: "10",
      isPrimaryKey: false,
      nullable: false,
      remark: "该计划策略的执行顺序。一个计划版本下有多个计划策略标识时，批价时的执行顺序。数值小的先执行。",
    },
    {
      name: "PLAN_POLICY_DESC",
      description: "策略说明",
      dataType: "VARCHAR2(4000)",
      length: "4000",
      isPrimaryKey: false,
      nullable: true,
      remark: "策略说明。策略的描述信息。",
    },
    {
      name: "PARENT_PLAN_POLICY_ID",
      description: "父计划策略标识",
      dataType: "NUMBER(20)",
      length: "20",
      isPrimaryKey: false,
      nullable: true,
      remark: "计划策略标识。唯一标识一个计划策略，由序列器自动生成。",
    },
  ],
  foreignKeys: [
    {
      name: "FK_PE_PLAN_POLICY_PLAN_VERSION",
      parentTable: "PE_PLAN_VERSION",
      childTable: "PE_PLAN_POLICY",
      cardinality: "1:N",
      cardinalityRaw: "0..*",
      deleteConstraint: "RESTRICT",
      updateConstraint: "RESTRICT",
      constraintName: "FK_PE_PLAN_POLICY_PLAN_VERSION",
      columnMapping: [{ parentColumn: "PLAN_VERSION_ID", childColumn: "PLAN_VERSION_ID" }],
    },
    {
      name: "FK_PE_PLAN_POLICY_PLY_CYCLE_ID",
      parentTable: "PE_POLICY_CYCLE",
      childTable: "PE_PLAN_POLICY",
      cardinality: "1:N",
      cardinalityRaw: "0..*",
      deleteConstraint: "RESTRICT",
      updateConstraint: "RESTRICT",
      constraintName: "FK_PE_PLAN_POLICY_PLY_CYCLE_ID",
      columnMapping: [{ parentColumn: "POLICY_CYCLE_ID", childColumn: "PLAN_POLICY_CYCLE_ID" }],
    },
    {
      name: "FK_PE_PLAN_POLICY_PLY_ID",
      parentTable: "PE_POLICY",
      childTable: "PE_PLAN_POLICY",
      cardinality: "1:N",
      cardinalityRaw: "0..*",
      deleteConstraint: "RESTRICT",
      updateConstraint: "RESTRICT",
      constraintName: "FK_PE_PLAN_POLICY_PLY_ID",
      columnMapping: [{ parentColumn: "POLICY_ID", childColumn: "POLICY_ID" }],
    },
  ],
  referencedBy: [
    {
      name: "Reference_48",
      parentTable: "PE_PLAN_POLICY",
      childTable: "PE_POLICY_SPECIAL_MATRIX",
      cardinality: "1:N",
      cardinalityRaw: "0..*",
      deleteConstraint: "RESTRICT",
      updateConstraint: "RESTRICT",
      constraintName: "",
      columnMapping: [{ parentColumn: "PLAN_POLICY_ID", childColumn: "PLAN_POLICY_ID" }],
    },
    {
      name: "FK_PE_PLAN_PLY_ATTR_PLAN_PLY",
      parentTable: "PE_PLAN_POLICY",
      childTable: "PE_PLAN_POLICY_ATTR",
      cardinality: "1:N",
      cardinalityRaw: "0..*",
      deleteConstraint: "RESTRICT",
      updateConstraint: "RESTRICT",
      constraintName: "FK_PE_PLAN_PLY_ATTR_PLAN_PLY",
      columnMapping: [{ parentColumn: "PLAN_POLICY_ID", childColumn: "PLAN_POLICY_ID" }],
    },
    {
      name: "FK_PE_P_PLY_PARAM_INST_PLY_ID",
      parentTable: "PE_PLAN_POLICY",
      childTable: "PE_PLAN_POLICY_PARAM_INST",
      cardinality: "1:N",
      cardinalityRaw: "0..*",
      deleteConstraint: "RESTRICT",
      updateConstraint: "RESTRICT",
      constraintName: "FK_PE_P_PLY_PARAM_INST_PLY_ID",
      columnMapping: [{ parentColumn: "PLAN_POLICY_ID", childColumn: "PLAN_POLICY_ID" }],
    },
    {
      name: "Reference_71",
      parentTable: "PE_PLAN_POLICY",
      childTable: "PE_PP_RULE",
      cardinality: "1:N",
      cardinalityRaw: "0..*",
      deleteConstraint: "RESTRICT",
      updateConstraint: "RESTRICT",
      constraintName: "",
      columnMapping: [{ parentColumn: "PLAN_POLICY_ID", childColumn: "PLAN_POLICY_ID" }],
    },
    {
      name: "Reference_72",
      parentTable: "PE_PLAN_POLICY",
      childTable: "PE_PP_TARGET",
      cardinality: "1:N",
      cardinalityRaw: "0..*",
      deleteConstraint: "RESTRICT",
      updateConstraint: "RESTRICT",
      constraintName: "",
      columnMapping: [{ parentColumn: "PLAN_POLICY_ID", childColumn: "PLAN_POLICY_ID" }],
    },
  ],
};

export const seedTables: SchemaTable[] = [
  {
    ...pePlanPolicyJson,
    className: "PlanPolicy",
    classDescription: pePlanPolicyJson.description,
    classAliases: [],
    domain0: "定价域",
    domain1: pePlanPolicyJson.folder,
  },
];

export const jsonExample = pePlanPolicyJson;
