const Field = require("@saltcorn/data/models/field");
const FieldRepeat = require("@saltcorn/data/models/fieldrepeat");

const Table = require("@saltcorn/data/models/table");
const { getState } = require("@saltcorn/data/db/state");
const db = require("@saltcorn/data/db");
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
  button,
  i,
  form,
  input,
  label,
  text_attr,
} = require("@saltcorn/markup/tags");
const {
  action_url,
  view_linker,
  parse_view_select,
  action_link,
  make_link,
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
          field_picker_repeat.push({
            name: "frozen",
            label: "Frozen",
            type: "Bool",
          });
          field_picker_repeat.push({
            name: "disable_edit",
            label: "Disable editing",
            type: "Bool",
            showIf: { type: "Field" },
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
      {
        name: "Options",
        form: async (context) => {
          const table = await Table.findOne(
            context.table_id
              ? { id: context.table_id }
              : { name: context.exttable_name }
          );
          const fields = await table.getFields();
          for (const field of fields) {
            await field.fill_fkey_options();
          }
          const { tabcolumns } = await get_tabulator_columns(
            context.viewname,
            table,
            fields,
            context.columns,
            false,
            undefined,
            false
          );
          const colFields = tabcolumns
            .filter((c) =>
              ["Field", "JoinField", "Aggregation"].includes(c.type)
            )
            .map((c) => c.field)
            .filter((s) => s);
          const groupByOptions = new Set([
            ...colFields,
            ...fields.map((f) => f.name),
          ]);
          return new Form({
            fields: [
              {
                name: "fit",
                label: "Layout Fit",
                type: "String",
                required: true,
                attributes: {
                  options: [
                    "Columns",
                    "Data",
                    "DataFill",
                    "DataStretch",
                    "DataTable",
                  ],
                },
              },
              {
                name: "groupBy",
                label: "Group by",
                type: "String",
                attributes: {
                  options: [...groupByOptions],
                },
              },
              {
                name: "hideColsBtn",
                label: "Show/hide columns",
                type: "Bool",
                sublabel: "Display drop-down menu to select shown columns",
              },
              {
                name: "hide_null_columns",
                label: "Hide null columns",
                sublabel:
                  "Do not display a column if it contains entirely missing values",
                type: "Bool",
              },
              {
                name: "addRowBtn",
                label: "Add row button",
                type: "Bool",
              },
              {
                name: "selectable",
                label: "Selectable",
                type: "Bool",
              },
              {
                name: "download_csv",
                label: "Download CSV",
                type: "Bool",
              },
              {
                name: "header_filters",
                label: "Header filters",
                type: "Bool",
              },
              {
                name: "movable_cols",
                label: "Movable columns",
                type: "Bool",
              },
              {
                name: "vert_col_headers",
                label: "Vertical column headers",
                type: "Bool",
              },
              {
                name: "history",
                label: "History (undo/redo)",
                type: "Bool",
              },
              {
                name: "pagination_size",
                label: "Pagination size",
                type: "Integer",
                default: 20,
              },
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
const typeToGridType = (t, field, header_filters) => {
  const jsgField = { field: field.name, title: field.label, editor: true };
  if (t.name === "String" && field.attributes && field.attributes.options) {
    jsgField.editor = "select";

    const values = field.attributes.options.split(",").map((o) => o.trim());
    if (!field.required) values.unshift("");

    jsgField.editorParams = { values };
    jsgField.headerFilter = !!header_filters;
  } else if (t.name === "String") {
    jsgField.headerFilter = !!header_filters;
  } else if (t === "Key" || t === "File") {
    jsgField.editor = "select";
    const values = {};

    field.options.forEach(({ label, value }) => (values[value] = label));
    jsgField.editorParams = { values };
    jsgField.formatterParams = { values };
    jsgField.formatter = "__lookupIntToString";
    jsgField.headerFilter = !!header_filters;
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
    jsgField.headerFilter = !!header_filters;
  } else if (t.name === "Bool") {
    jsgField.editor = "tickCross";
    jsgField.formatter = "tickCross";
    jsgField.hozAlign = "center";
    jsgField.vertAlign = "center";
    jsgField.editorParams = field.required ? {} : { tristate: true };
    jsgField.formatterParams = field.required ? {} : { allowEmpty: true };
    jsgField.headerFilter = !!header_filters;
  } else if (t.name === "Date") {
    jsgField.sorter = "date";

    jsgField.sorter = "date";
    jsgField.sorterParams = {
      format: "iso",
    };
    jsgField.editor = "__flatpickerEditor";

    if (field.fieldview === "showDay") {
      jsgField.editorParams = { dayOnly: true };
      jsgField.formatter = "__isoDateFormatter";
    } else {
      jsgField.formatter = "datetime";
      jsgField.formatterParams = {
        inputFormat: "iso",
      };
    }
    jsgField.headerFilter = !!header_filters;
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

const set_join_fieldviews = async ({ columns, fields }) => {
  for (const segment of columns) {
    const { join_field, join_fieldview } = segment;
    if (!join_fieldview) continue;
    const keypath = join_field.split(".");
    if (keypath.length === 2) {
      const [refNm, targetNm] = keypath;
      const ref = fields.find((f) => f.name === refNm);
      if (!ref) continue;
      const table = await Table.findOne({ name: ref.reftable_name });
      if (!table) continue;
      const reffields = await table.getFields();
      const field = reffields.find((f) => f.name === targetNm);
      segment.field_obj = field;
      if (field && field.type === "File") segment.field_type = "File";
      else if (
        field &&
        field.type &&
        field.type.name &&
        field.type.fieldviews &&
        field.type.fieldviews[join_fieldview]
      )
        segment.field_type = field.type.name;
    } else {
      //const [refNm, through, targetNm] = keypath;
    }
  }
};

const get_tabulator_columns = async (
  viewname,
  table,
  fields,
  columns,
  isShow,
  req,
  header_filters,
  vert_col_headers
) => {
  const tabcols = [];
  const calculators = [];
  const dropdown_actions = [];
  for (const column of columns) {
    let tcol = {};
    if (column.type === "Field") {
      let f = fields.find((fld) => fld.name === column.field_name);
      if (!f) return {};
      f.fieldview = column.fieldview;
      if (column.fieldview === "subfield") {
        tcol.editor = false;
        const key = `${column.field_name}_${column.key}`;
        calculators.push((row) => {
          row[key] = (row[column.field_name] || {})[column.key];
        });
        tcol.field = key;
        tcol.title = column.key;
      } else tcol = typeToGridType(f.type, f, header_filters);
    } else if (column.type === "JoinField") {
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
      if (column.field_type && column.field_obj) {
        tcol = typeToGridType(
          getState().types[column.field_type],
          column.field_obj
        );
      }
      tcol.field = key;
      tcol.editor = false;
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
      tcol.clipboard = false;
    } else if (column.type === "Link") {
      tcol.formatter = "html";
      const rndid = "col" + Math.floor(Math.random() * 16777215).toString(16);

      const { key } = make_link(column, fields);
      calculators.push((row) => {
        row[rndid] = key(row);
      });
      tcol.field = rndid;
      tcol.clipboard = false;
    } else if (
      column.type === "Action" &&
      column.action_name === "Delete" &&
      !column.in_dropdown
    ) {
      tcol = {
        formatter: "buttonCross",
        title: i({ class: "far fa-trash-alt" }),
        width: 40,
        hozAlign: "center",
        headerSort: false,
        clipboard: false,
        cellClick: "__delete_tabulator_row",
      };
    } else if (column.type === "Action") {
      tcol.formatter = "html";
      //console.log(column);
      const rndid = "col" + Math.floor(Math.random() * 16777215).toString(16);
      calculators.push((row) => {
        const url = action_url(
          viewname,
          table,
          column.action_name,
          row,
          column.action_name,
          "action_name"
        );
        row[rndid] = column.in_dropdown ? url : action_link(url, req, column);
      });
      tcol.field = rndid;
      tcol.clipboard = false;
      if (column.in_dropdown) {
        dropdown_actions.push({
          rndid,
          label: column.label || column.action_name,
        });
        tcol = false;
      }
    }
    if (!tcol) continue;
    if (column.header_label) tcol.title = column.header_label;
    if (column.frozen) tcol.frozen = true;
    if (column.disable_edit) tcol.editor = false;
    if (vert_col_headers) tcol.headerVertical = true;
    tabcols.push(tcol);
  }
  let arndid;
  if (dropdown_actions.length > 0) {
    arndid = "col" + Math.floor(Math.random() * 16777215).toString(16);
    calculators.push((row) => {
      row[arndid] = "Actions";
    });
    const values = {};
    dropdown_actions.forEach(({ label, rndid }) => {
      values[rndid] = label;
    });
    tabcols.push({
      formatter: "html",
      field: arndid,
      title: "Actions",
      clipboard: false,
      editor: "select",
      editorParams: { values },
      headerSort: false,
      clipboard: false,
      cssClass: "tabu_action_dd",
    });
  }
  return {
    tabcolumns: tabcols,
    calculators,
    dropdown_id: arndid,
    dropdown_actions,
  };
};

const addRowButton = () =>
  button(
    {
      class: "btn btn-sm btn-primary me-2",
      onClick: "add_tabulator_row()",
    },
    i({ class: "fas fa-plus me-1" }),
    "Add row"
  );

const hideShowColsBtn = (tabcolumns) =>
  div(
    { class: "dropdown d-inline" },
    button(
      {
        class: "btn btn-sm btn-outline-secondary dropdown-toggle",
        "data-boundary": "viewport",
        type: "button",
        id: "btnHideCols",
        "data-bs-toggle": "dropdown",
        "aria-haspopup": "true",
        "aria-expanded": "false",
      },
      "Show/hide fields"
    ),
    div(
      {
        class: "dropdown-menu",
        "aria-labelledby": "btnHideCols",
      },
      form(
        { class: "px-2" },
        tabcolumns.map(
          (f) =>
            f.field &&
            div(
              { class: "form-check" },
              input({
                type: "checkbox",
                onChange: `showHideCol('${f.field}', this)`,
                class: "form-check-input",
                checked: true,
              }),
              label(f.title || f.field)
            )
        )
      )
    )
  );
const run = async (
  table_id,
  viewname,
  {
    columns,
    default_state,
    fit,
    hideColsBtn,
    hide_null_columns,
    addRowBtn,
    selectable,
    download_csv,
    header_filters,
    pagination_size,
    movable_cols,
    history,
    groupBy,
    vert_col_headers,
  },
  state,
  extraArgs
) => {
  const table = await Table.findOne({ id: table_id });
  const fields = await table.getFields();
  for (const field of fields) {
    await field.fill_fkey_options();
  }
  readState(state, fields);
  const where = await stateFieldsToWhere({ fields, state });
  const q = await stateFieldsToQuery({ state, fields, prefix: "a." });
  const rows_per_page = default_state && default_state._rows_per_page;
  if (!q.limit && rows_per_page) q.limit = rows_per_page;
  if (!q.orderBy)
    q.orderBy = (default_state && default_state._order_field) || table.pk_name;
  if (!q.orderDesc) q.orderDesc = default_state && default_state._descending;
  const current_page = parseInt(state._page) || 1;
  const { joinFields, aggregations } = picked_fields_to_query(columns, fields);
  await set_join_fieldviews({ columns, fields });

  let rows = await table.getJoinedRows({
    where,
    joinFields,
    aggregations,
    ...q,
  });
  const {
    tabcolumns,
    calculators,
    dropdown_id,
    dropdown_actions,
  } = await get_tabulator_columns(
    viewname,
    table,
    fields,
    columns,
    false,
    extraArgs.req,
    header_filters,
    vert_col_headers
  );
  calculators.forEach((f) => {
    rows.forEach(f);
  });
  if (selectable)
    tabcolumns.unshift({
      formatter: "rowSelection",
      titleFormatter: "rowSelection",
      headerSort: false,
      width: "20",
      clipboard: false,
      frozen: tabcolumns[0].frozen,
    });
  const use_tabcolumns = hide_null_columns
    ? tabcolumns.filter(
        (c) =>
          !c.field ||
          rows.some(
            (row) =>
              row[c.field] !== null && typeof row[c.field] !== "undefined"
          )
      )
    : tabcolumns;
  return div(
    //script(`var edit_fields=${JSON.stringify(jsfields)};`),
    //script(domReady(versionsField(table.name))),
    style(`.tabulator-cell.tabu_action_dd:after {content: "\\25bc";}`),
    script(
      domReady(`
      const columns=${JSON.stringify(use_tabcolumns)};          
      columns.forEach(col=>{
        Object.entries(col).forEach(([k,v])=>{
          if(typeof v === "string" && v.startsWith("__"))
            col[k] = window[v.substring(2)];
        })
      })   
    window.tabulator_table = new Tabulator("#tabgrid${viewname}", {
        data: ${JSON.stringify(rows)},
        layout:"fit${fit || "Columns"}", 
        columns,
        height:"100%",
        pagination:true,
        paginationSize:${pagination_size || 20},
        clipboard:true,
        persistence:true, 
        persistenceID:"tabview_${viewname}",
        movableColumns: ${!!movable_cols},
        history: ${!!history},
        ${groupBy ? `groupBy: "${groupBy}",` : ""}
        //initialSort:[
        //  {column:"id", dir:"asc"},
        //],
        ajaxResponse:function(url, params, response){                    
  
          return response.success; //return the tableData property of a response json object
        },
    });
    function save_row_from_cell( row, cell, noid) {
       $.ajax({
        type: "POST",
        url: "/api/${table.name}/" + (noid?'':(row.id||"")),
        data: row,
        headers: {
          "CSRF-Token": _sc_globalCsrf,
        },
        error: tabulator_error_handler,
      }).done(function (resp) {
        if(resp.success &&typeof resp.success ==="number" && !row.id && cell) {
          window.tabulator_table.updateRow(cell.getRow(), {id: resp.success});
        }
      });
    }
    const dropdown_actions = ${JSON.stringify(dropdown_actions)};
    window.tabulator_table.on("cellEdited", function(cell){
      const row=cell.getRow().getData();
      if(cell.getField()==="${dropdown_id}"){
        const val = cell.getValue();
        const action= row[val]
        if(typeof action==="string") {
          const form = document.createElement('form');
          form.method = 'POST';
          form.action = action;
          const hiddenField = document.createElement('input');
          hiddenField.type = 'hidden';
          hiddenField.name = '_csrf';
          hiddenField.value = _sc_globalCsrf;
          form.appendChild(hiddenField);
          document.body.appendChild(form);
          form.submit();
        }         
        if(action && action.javascript)
          eval(action.javascript)        
      }
      else save_row_from_cell(row, cell)
    });
    window.tabulator_table.on("historyUndo", function(action, component, data){
      
      switch (action) {
        case "cellEdit": 
          save_row_from_cell(component.getRow().getData(), component)
          break;
        case "rowDelete": 
          const {id, ...delRow} = data.data
          save_row_from_cell( data.data, undefined, true)
          break;
      }
    })
    window.tabulator_table.on("historyRedo", function(action, component, data){
      switch (action) {
        case "cellEdit": 
          save_row_from_cell(component.getRow().getData(), component)
          break;
      }
    })
    window.tabulator_table_name="${table.name}";
    ${
      download_csv
        ? `document.getElementById("tabulator-download-csv").addEventListener("click", function(){
            const selectedData = window.tabulator_table.getSelectedData();
            window.tabulator_table.download("csv", "${viewname}.csv",{}, selectedData.length>0 ? "selected" : "all");
          });`
        : ""
    }`)
    ),
    div({ id: "jsGridNotify" }),
    div(
      { class: "d-flex justify-content-end w-100 mb-1" },
      history &&
        button(
          {
            class: "btn btn-sm btn-primary me-2",
            title: "Undo",
            onClick: "window.tabulator_table.undo()",
          },
          i({ class: "fas fa-undo" })
        ),
      history &&
        button(
          {
            class: "btn btn-sm btn-primary me-2",
            title: "Redo",
            onClick: "window.tabulator_table.redo()",
          },
          i({ class: "fas fa-redo" })
        ),
      download_csv &&
        button(
          {
            class: "btn btn-sm btn-primary me-2",
            id: "tabulator-download-csv",
          },
          i({ class: "fas fa-download me-1" }),
          "Download"
        ),
      addRowBtn && addRowButton(),
      hideColsBtn && hideShowColsBtn(tabcolumns)
    ),
    div({ id: `tabgrid${viewname}` })
  );
};

const run_action = async (
  table_id,
  viewname,
  { columns, layout },
  body,
  { req, res }
) => {
  const col = columns.find(
    (c) =>
      c.type === "Action" &&
      c.action_name === body.action_name &&
      body.action_name
  );
  //console.log({ col, body });
  const table = await Table.findOne({ id: table_id });
  const row = await table.getRow({ id: body.id });
  const state_action = getState().actions[col.action_name];
  col.configuration = col.configuration || {};
  if (state_action) {
    const cfgFields = await getActionConfigFields(state_action, table);
    cfgFields.forEach(({ name }) => {
      col.configuration[name] = col[name];
    });
  }
  try {
    const result = await run_action_column({
      col,
      req,
      table,
      row,
      referrer: req.get("Referrer"),
    });
    return { json: { success: "ok", ...(result || {}) } };
  } catch (e) {
    return { json: { error: e.message || e } };
  }
};
module.exports = {
  headers: ({ stylesheet }) => [
    {
      script: "/plugins/public/tabulator/tabulator.min.js",
    },
    {
      script: "/plugins/public/tabulator/luxon.min.js",
    },
    {
      script: "/flatpickr.min.js",
    },
    {
      css: `/flatpickr.min.css`,
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
      routes: { run_action },
    },
  ],
};
