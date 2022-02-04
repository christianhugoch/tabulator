const Field = require("@saltcorn/data/models/field");
const FieldRepeat = require("@saltcorn/data/models/fieldrepeat");

const Table = require("@saltcorn/data/models/table");
const Form = require("@saltcorn/data/models/form");
const View = require("@saltcorn/data/models/view");
const Workflow = require("@saltcorn/data/models/workflow");
const {
  field_picker_fields,
  picked_fields_to_query,
  stateFieldsToWhere,
  initial_config_all_fields,
  stateToQueryString,
  stateFieldsToQuery,
  link_view,
  getActionConfigFields,
  readState,
  run_action_column,
} = require("@saltcorn/data/plugin-helper");
const {
  text,
  div,
  h5,
  style,
  a,
  script,
  pre,
  domReady,
  i,
  text_attr,
} = require("@saltcorn/markup/tags");
const {
  action_url,
  view_linker,
  parse_view_select,
  action_link,
  splitUniques,
} = require("@saltcorn/data/base-plugin/viewtemplates/viewable_fields");

const configuration_workflow = () =>
  new Workflow({
    steps: [
      {
        name: "views",
        form: async (context) => {
          return new Form({
            fields: [
              {
                name: "stylesheet",
                label: "Stylesheet",
                type: "String",
                required: true,
                attributes: {
                  options: [
                    "bootstrap4",
                    "midnight",
                    "modern",
                    "simple",
                    "site",
                  ],
                },
              },
            ],
          });
        },
      },
    ],
  });

const view_configuration_workflow = (req) =>
  new Workflow({
    steps: [
      {
        name: "Columns",
        form: async (context) => {
          const table = await Table.findOne(
            context.table_id
              ? { id: context.table_id }
              : { name: context.exttable_name }
          );
          //console.log(context);
          const field_picker_repeat = await field_picker_fields({
            table,
            viewname: context.viewname,
            req,
          });
          const use_field_picker_repeat = field_picker_repeat.filter(
            (f) => !["state_field"].includes(f.name)
          );
          return new Form({
            fields: [
              new FieldRepeat({
                name: "columns",
                fields: use_field_picker_repeat,
              }),
            ],
          });
        },
      },
    ],
  });

const get_state_fields = async (table_id, viewname, { show_view }) => {
  const table_fields = await Field.find({ table_id });
  return table_fields
    .filter((f) => !f.primary_key)
    .map((f) => {
      const sf = new Field(f);
      sf.required = false;
      return sf;
    });
};
//copy from server/routes/list.js
const typeToGridType = (t, field) => {
  const jsgField = { field: field.name, title: field.label, editor: true };
  if (t.name === "String" && field.attributes && field.attributes.options) {
    jsgField.editor = "select";

    const values = field.attributes.options.split(",").map((o) => o.trim());
    if (!field.required) values.unshift("");

    jsgField.editorParams = { values };
  } else if (t === "Key" || t === "File") {
    jsgField.editor = "select";
    const values = {};

    field.options.forEach(({ label, value }) => (values[value] = label));
    jsgField.editorParams = { values };
    jsgField.formatterParams = { values };
    jsgField.formatter = "__lookupIntToString";
  } else if (t.name === "Float" || t.name === "Integer") {
    jsgField.editor = "number";
    jsgField.sorter = "number";
    jsgField.hozAlign = "right";
    jsgField.headerHozAlign = "right";
    jsgField.editorParams = {
      step: t.name === "Integer" ? 1 : undefined,
      min:
        typeof field.attributes.min !== "undefined"
          ? field.attributes.min
          : undefined,
      max:
        typeof field.attributes.max !== "undefined"
          ? field.attributes.max
          : undefined,
    };
  } else if (t.name === "Bool") {
    jsgField.editor = "tickCross";
    jsgField.formatter = "tickCross";
    jsgField.hozAlign = "center";
    jsgField.vertAlign = "center";
    jsgField.editorParams = field.required ? {} : { tristate: true };
    jsgField.formatterParams = field.required ? {} : { allowEmpty: true };
  } else if (t.name === "Date") {
    jsgField.sorter = "date";
    jsgField.editor = "__flatpickerEditor";
    jsgField.formatter = "__isoDateTimeFormatter";
  } else if (t.name === "Color") {
    jsgField.editor = "__colorEditor";
    jsgField.formatter = "__colorFormatter";
    jsgField.hozAlign = "center";
    jsgField.vertAlign = "center";
  } else if (t.name === "JSON") {
    jsgField.formatter = "__jsonFormatter";
    jsgField.editor = "__jsonEditor";
  }

  if (field.calculated) {
    jsgField.editor = false;
  }
  if (field.primary_key) {
    jsgField.editor = false;
  }
  return jsgField;
};

const get_tabulator_columns = async (
  viewname,
  table,
  fields,
  columns,
  isShow,
  req
) => {
  const tabcols = [];
  const calculators = [];
  for (const column of columns) {
    const role = req.user ? req.user.role_id : 10;
    const user_id = req.user ? req.user.id : null;
    const setWidth = column.col_width
      ? { width: `${column.col_width}${column.col_width_units}` }
      : {};
    let tcol = {};
    if (column.type === "Field") {
      let f = fields.find((fld) => fld.name === column.field_name);
      if (!f) return {};
      tcol = typeToGridType(f.type, f);
    } else if (column.type === "JoinField") {
      tcol.editor = false;
      let refNm, targetNm, through, key, type;
      if (column.join_field.includes("->")) {
        const [relation, target] = column.join_field.split("->");
        const [ontable, ref] = relation.split(".");
        targetNm = target;
        refNm = ref;
        key = `${ref}_${ontable}_${target}`;
      } else {
        const keypath = column.join_field.split(".");
        if (keypath.length === 2) {
          [refNm, targetNm] = keypath;
          key = `${refNm}_${targetNm}`;
        } else {
          [refNm, through, targetNm] = keypath;
          key = `${refNm}_${through}_${targetNm}`;
        }
      }
      tcol.field = key;
    } else if (column.type === "Aggregation") {
      const [table, fld] = column.agg_relation.split(".");
      const targetNm = (
        column.stat.replace(" ", "") +
        "_" +
        table +
        "_" +
        fld +
        db.sqlsanitize(column.aggwhere || "")
      ).toLowerCase();
      tcol.field = targetNm;
    } else if (column.type === "ViewLink") {
      tcol.formatter = "html";
      const { key } = view_linker(column, fields);
      calculators.push((row) => {
        row[column.view] = key(row);
      });
      tcol.field = column.view;
    }
    if (column.header_label) tcol.title = column.header_label;
    tabcols.push(tcol);
  }
  return { tabcolumns: tabcols, calculators };
};
const run = async (
  table_id,
  viewname,
  { columns, default_state },
  state,
  extraArgs
) => {
  const table = await Table.findOne({ id: table_id });
  const fields = await table.getFields();
  readState(state, fields);
  const where = await stateFieldsToWhere({ fields, state });
  const q = await stateFieldsToQuery({ state, fields, prefix: "a." });
  const rows_per_page = (default_state && default_state._rows_per_page) || 20;
  if (!q.limit) q.limit = rows_per_page;
  if (!q.orderBy)
    q.orderBy = (default_state && default_state._order_field) || table.pk_name;
  if (!q.orderDesc) q.orderDesc = default_state && default_state._descending;
  const current_page = parseInt(state._page) || 1;
  const { joinFields, aggregations } = picked_fields_to_query(columns, fields);
  let rows = await table.getJoinedRows({
    where,
    joinFields,
    aggregations,
    ...q,
  });
  const { tabcolumns, calculators } = await get_tabulator_columns(
    viewname,
    table,
    fields,
    columns,
    false,
    extraArgs.req
  );
  calculators.forEach((f) => {
    rows.forEach(f);
  });
  //console.log(table);
  return div(
    //script(`var edit_fields=${JSON.stringify(jsfields)};`),
    //script(domReady(versionsField(table.name))),
    script(
      domReady(`
      const columns=${JSON.stringify(tabcolumns)};          
      columns.forEach(col=>{
        Object.entries(col).forEach(([k,v])=>{
          if(typeof v === "string" && v.startsWith("__"))
            col[k] = window[v.substring(2)];
        })
      })   
    window.tabulator_table = new Tabulator("#jsGrid", {
        data: ${JSON.stringify(rows)},
        layout:"fitColumns", 
        columns,
        height:"100%",
        pagination:true,
        paginationSize:20,
        initialSort:[
          {column:"id", dir:"asc"},
        ],
        ajaxResponse:function(url, params, response){                    
  
          return response.success; //return the tableData property of a response json object
        },
    });
    window.tabulator_table.on("cellEdited", function(cell){
      const row = cell.getRow().getData()
      $.ajax({
        type: "POST",
        url: "/api/${table.name}/" + (row.id||""),
        data: row,
        headers: {
          "CSRF-Token": _sc_globalCsrf,
        },
        error: tabulator_error_handler,
      }).done(function (resp) {
        //if (item._versions) item._versions = +item._versions + 1;
        //data.resolve(fixKeys(item));
        if(resp.success &&typeof resp.success ==="number" && !row.id) {
          window.tabulator_table.updateRow(cell.getRow(), {id: resp.success});
        }

      });
    });
    window.tabulator_table_name="${table.name}";`)
    ),
    div({ id: "jsGridNotify" }),

    div({ id: "jsGrid" })
  );
};

module.exports = {
  headers: ({ stylesheet }) => [
    {
      script: "/plugins/public/tabulator/tabulator.min.js",
    },
    {
      script: "/gridedit.js",
    },
    {
      css: `/plugins/public/tabulator/tabulator_${stylesheet}.min.css`,
    },
  ],
  sc_plugin_api_version: 1,
  plugin_name: "tabulator",
  configuration_workflow,
  viewtemplates: () => [
    {
      name: "Tabulator",
      display_state_form: false,
      get_state_fields,
      configuration_workflow: view_configuration_workflow,
      run,
    },
  ],
};
