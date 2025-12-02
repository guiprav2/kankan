export default class CardEditorDialog {
  constructor(props = {}) {
    this.props = props;
    let columns = Array.isArray(props.columns) ? props.columns : [];
    this.form = {
      title: props.card?.title || '',
      description: props.card?.description || '',
      tag: props.card?.tag || '',
      columnId: props.card?.columnId || props.columnId || columns[0]?.id || '',
    };
    if (!this.form.columnId && columns[0]) this.form.columnId = columns[0].id;
    this.error = '';
  }
  close(value = 'cancel', detail) {
    let dialog = this.root?.parentElement;
    if (!dialog) return;
    if (detail !== undefined) dialog.returnDetail = detail;
    dialog.close(value);
  }
  cancel = () => this.close('cancel');
  get valid() {
    return !!this.form.title?.trim?.();
  }
  submit = ev => {
    ev?.preventDefault?.();
    this.error = '';
    if (!this.valid) {
      this.error = 'Title is required.';
      return;
    }
    if (!this.form.columnId && this.props.columns?.length) {
      this.form.columnId = this.props.columns[0].id;
    }
    let payload = {
      title: this.form.title,
      description: this.form.description,
      tag: this.form.tag,
      columnId: this.form.columnId,
    };
    this.close('ok', payload);
  };
}
