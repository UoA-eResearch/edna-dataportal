"use strict";

$(document).ready(function() {
    var authentication_token = null;
    var spinner = setupSpinner('spinner');
    var modalSpinner = setupSpinner('modal-spinner');

    function setupSpinner(elementId) {
        var theSpinner = null;

        function stop_spinner() {
            if (theSpinner) {
                theSpinner.stop();
                theSpinner = null;
            }
        }

        function start_spinner() {
            var opts = {
                lines: 15, // The number of lines to draw
                length: 14, // The length of each line
                width: 10, // The line thickness
                radius: 20, // The radius of the inner circle
                corners: 1, // Corner roundness (0..1)
                rotate: 60, // The rotation offset
                direction: 1, // 1: clockwise, -1: counterclockwise
                color: '#000', // #rgb or #rrggbb or array of colors
                speed: 2.2, // Rounds per second
                trail: 95, // Afterglow percentage
                shadow: true, // Whether to render a shadow
                hwaccel: false, // Whether to use hardware acceleration
                className: 'spinner', // The CSS class to assign to the spinner
                zIndex: 2e9, // The z-index (defaults to 2000000000)
                top: '50%', // Top position relative to parent
                left: '50%' // Left position relative to parent
            };
            var target = document.getElementById(elementId);

            if (!theSpinner) {
                theSpinner = new Spinner(opts).spin(target);
            }
        }
        return {
          start: start_spinner,
          stop: stop_spinner
        }
    };

    var taxonomy_hierarchy = [
        "kingdom",
        "phylum",
        "class",
        "order",
        "family",
        "genus",
        "species"
    ];
    var blank_option = {'text': '----', 'value': null};
    var loading_option = {'text': 'Loading ....', 'value': null};
    // this is populated via an ajax call, and specifies the
    // contextual metadata fields and their types
    var contextual_config;
    var next_contextual_filter_id = 1;
    var datatable;

    var set_options = function(target, options) {
        target.empty();
        $.each(options, function(index, option) {
            $('<option/>').val(option.value).text(option.text).appendTo(target);
        });
    };

    var taxonomy_selector = function(s) {
        return '#taxonomy_' + s;
    };

    var taxonomy_label_selector = function(s) {
        return '[for="taxonomy_' + s + '"]';
    };

    var taxonomy_op_selector = function(s) {
        return '#taxonomy_' + s + '_op';
    };

    var amplicon_set_possibilities = function(options) {
        options.unshift([null, '- All -']);
        set_options($('#amplicon'),  _.map(options, function(val) {
            return {
                'value': val[0],
                'text': val[1]
            }
        }));
    };

    var taxonomy_clear = function(taxonomy) {
        var target = $(taxonomy_selector(taxonomy));
        set_options(target, [blank_option]);
        var opTarget = $(taxonomy_op_selector(taxonomy));
        opTarget.val('is');
    };

    var taxonomy_set_enabled = function(taxonomy, enabled) {
        var lblTarget = $(taxonomy_label_selector(taxonomy));
        if (enabled) {
          lblTarget.removeClass('disabled')
        } else {
          lblTarget.addClass('disabled')
        }
        $(taxonomy_op_selector(taxonomy)).prop('disabled', !enabled);
        $(taxonomy_selector(taxonomy)).prop('disabled', !enabled);
    };

    var taxonomy_enable = _.partialRight(taxonomy_set_enabled, true);
    var taxonomy_disable = _.partialRight(taxonomy_set_enabled, false);

    var taxonomies_disable_clear = function(taxonomies) {
      _.each(taxonomies, function(s) {
          taxonomy_disable(s);
          taxonomy_clear(s);
      });
    }

    var taxonomy_set_loading = function(taxonomy) {
        var target = $(taxonomy_selector(taxonomy));
        set_options(target, [loading_option]);
    };

    var taxonomy_set_possibilities = function(result) {
        // first, we clear any drop-downs invalidated by this
        // new information
        taxonomies_disable_clear(result['clear']);
        // then set possibilities for the target we've been given
        var new_options = result['new_options'];
        if (!new_options) {
            return;
        }
        var target = $(taxonomy_selector(new_options['target']));
        set_options(target, [blank_option].concat(_.map(new_options['possibilities'], function(val) {
            return {
                'value': val[0],
                'text': val[1]
            }
        })));
        taxonomy_enable(new_options['target']);
    };

    var taxonomy_get_state = function() {
        return _.map(taxonomy_hierarchy, function(s) {
          return {
            'value': $(taxonomy_selector(s)).val(),
            'operator': $(taxonomy_op_selector(s)).val()
          };
        });
    };

    var taxonomy_all_after = function(taxonomy) {
        var idx = taxonomy_hierarchy.indexOf(taxonomy);
        return taxonomy_hierarchy.slice(idx + 1);
    }

    var taxonomy_refresh = function(taxonomy) {
        var allAfter = taxonomy_all_after(taxonomy);

        taxonomies_disable_clear(allAfter);

        var refreshAll = (typeof taxonomy === "undefined");
        var wasUnset = ($(taxonomy_selector(taxonomy)).val() == "");

        if (refreshAll || !wasUnset) {
          var nextTaxonomy = _.first(allAfter);
          loadTaxonomy(nextTaxonomy);
        }

        function loadTaxonomy(taxonomy) {
          taxonomy_set_loading(taxonomy);

          $.when(check_for_auth_token()).done(function() {
              $.ajax({
                  method: 'GET',
                  dataType: 'json',
                  url: window.otu_search_config['taxonomy_endpoint'],
                  data: {
                      'token': authentication_token,
                      'amplicon': JSON.stringify(marshal_amplicon_filter()),
                      'selected': JSON.stringify(taxonomy_get_state())
                  }
              }).done(function(result) {
                  taxonomy_set_possibilities(result['possibilities']);
              });
          });
        };
    };

    var setup_taxonomic = function() {
        // hook up all of our events
        $.each(taxonomy_hierarchy.slice(0, -1), function(idx, s) {
            $(taxonomy_selector(s)).on('change', function() {
                taxonomy_refresh(s);
            });
            $(taxonomy_op_selector(s)).on('change', function() {
                taxonomy_refresh(s);
            });
         });
        $("#clear_taxonomic_filters").click(function () {
            $("#amplicon").val(null);
            $("#amplicon_op").val('is');
            $.each(taxonomy_hierarchy, function(idx, s) {
                $(taxonomy_selector(s)).val(null);
                $(taxonomy_op_selector(s)).val('is');
            });
            taxonomy_refresh();
        });
        // get initial selections
        taxonomy_refresh();
    };

    var setup_amplicon = function() {
        $("#amplicon").on('change', function() { taxonomy_refresh() });
        $("#amplicon_op").on('change', function() { taxonomy_refresh() });
        $.when(check_for_auth_token()).done(function() {
            $.ajax({
                method: 'GET',
                dataType: 'json',
                url: window.otu_search_config['amplicon_endpoint'],
                data: {
                    'token': authentication_token
                }
            }).done(function(result) {
                amplicon_set_possibilities(result['possibilities']);
            });
        });
    };

    var update_contextual_controls = function() {
        var filters = $("#contextual_filters_target > div");
        var target = $("#contextual_filters_mode_para");
        if (filters.length > 1) {
            target.show()
        } else {
            target.hide()
        }
    };

    var get_environment = function() {
        return marshal_environment_filter();
    }

    var configure_unselected_contextual_filters = function() {
        var current_environment = get_environment();
        $.each($("#contextual_filters_target > div"), function(idx, target) {
            var select_box = $(".contextual-item", target);
            var select_val = select_box.val();
            if (select_val !== null && select_val !== '') {
                return;
            }

            // if we have an environment ID set, we filter the available options to those for that environment ID and those which are cross-environment
            var applicable_definitions = _.filter(contextual_config['definitions'], function (val) {
                // we don't ever select environment through the dynamic UI
                if (val.name == "environment_id") {
                    return false;
                }
                // we don't have a environment ID selected
                if (current_environment === null || !current_environment.value) {
                    return true;
                }
                // it's not a environment specific field
                if (val.environment === null) {
                    return true;
                }
                if (current_environment.operator === 'isnot') {
                    return current_environment.value != val.environment;
                } else {
                    return current_environment.value == val.environment;
                }
                return false;
            });
            set_options(select_box, [blank_option].concat(_.map(applicable_definitions, function(val) {
                var dn = val['display_name'];
                var units = val['units'];
                if (units) {
                    dn = dn + ' [' + units + ']';
                }
                return {
                    'value': val['name'],
                    'text': dn
                }
            })));
        });
    }

    var add_contextual_filter = function() {
        if (!contextual_config) {
            // initial config not loaded yet
            return;
        }
        var new_filter_id = 'contextual-filter-' + next_contextual_filter_id;
        next_contextual_filter_id += 1;
        var d = $([
            '<div class="row contextual-filter-row" id="' + new_filter_id + '">',
            '<div class="col-md-1 no-padding-right"><button class="form-control remove-button" type="button"><span class="glyphicon glyphicon-minus" aria-hidden="true"></span></button></div>',
            '<div class="col-md-4 no-padding-right"><select class="form-control contextual-item"></select></div>',
            '<div class="col-md-7 contextual-entry"></div>',
            '</div>'
        ].join("\n"));
        $("#contextual_filters_target").append(d);
        var select_box = $('#' + new_filter_id + " select");
        select_box.on('change', function() {
            var target = $('#' + new_filter_id + " .contextual-entry");
            target.empty();

            var defn_name = select_box.val();
            var defn = _.find(contextual_config['definitions'], {'name': defn_name});
            var defn_type = defn['type'];

            var widget;
            if (defn_type == 'sample_id') {
                widget = $('<select multiple class="form-control cval_select"></select>');
                set_options(widget, _.map(defn['values'], function(val) {
                    return {
                        'value': val,
                        'text': val,
                    }
                }));
            } else if (defn_type == 'date') {
                widget = $([
                    '<div class="row">',
                    '<div class="col-md-4 no-padding-right">',
                      '<select class="form-control cval_op">',
                        '<option value="between">between</option>',
                        '<option value="notbetween">not between</option>',
                    '</select></div>',
                    '<div class="col-md-4"><input class="form-control cval_from" /></div>',
                    '<div class="col-md-4"><input class="form-control cval_to" /></div>',
                    '</div>'
                ].join("\n"));
            } else if (defn_type == 'float') {
                widget = $([
                    '<div class="row">',
                    '<div class="col-md-4 no-padding-right">',
                      '<select class="form-control cval_op">',
                        '<option value="between">between</option>',
                        '<option value="notbetween">not between</option>',
                    '</select></div>',
                     '<div class="col-md-4"><input class="form-control cval_from" /></div>',
                    '<div class="col-md-4"><input class="form-control cval_to" /></div>',
                    '</div>'
                ].join("\n"));
            } else if (defn_type == 'string') {
                widget = $([
                    '<div class="row">',
                    '<div class="col-md-4 no-padding-right">',
                      '<select class="form-control cval_op">',
                        '<option value="contains">contains</option>',
                        '<option value="containsnot">doesn\'t contain</option>',
                    '</select></div>',
                    '<div class="col-md-8"><input class="form-control cval_contains" /></div>',
                    '</div>'
                ].join("\n"));
            } else if (defn_type == 'ontology') {
                widget = $([
                    '<div class="row">',
                    '<div class="col-md-4 no-padding-right">',
                      '<select class="form-control cval_op">',
                        '<option value="is">is</option>',
                        '<option value="isnot">isn\'t</option>',
                      '</select></div>',
                    '<div class="col-md-8"><select class="form-control cval_select"></select></div>',
                    '</div>'
                ].join("\n"));
                // clone
                var options = defn['values'].slice(0);
                options.unshift([null, '- All -']);
                set_options(widget.find('.cval_select'), _.map(options, function(val) {
                    return {
                        'value': val[0],
                        'text': val[1]
                    }
                }));
            }
            target.append(widget);
            target.trigger('otu:filter_changed');
        });
        $('#' + new_filter_id + ' button').click(function() {
            $('#' + new_filter_id).remove();
            update_contextual_controls();
        });
        configure_unselected_contextual_filters();
        update_contextual_controls();
        return new_filter_id;
    };

    var setup_contextual = function() {
        // hook up all of our events
        $("#add_contextual_filter").click(function() {
            add_contextual_filter();
        });
        $("#clear_contextual_filters").click(function() {
            $("#contextual_filters_target").empty();
            update_contextual_controls();
        });

        $.when(check_for_auth_token()).done(function() {
            // get configuration of the various filters
            $.ajax({
                method: 'GET',
                dataType: 'json',
                url: window.otu_search_config['contextual_endpoint'],
                data: {
                    'token': authentication_token,
                }
            }).done(function(result) {
                contextual_config = result;
                // set up the environment filter
                var widget = $("#environment");
                var defn = _.find(contextual_config['definitions'], {'name': 'environment_id'});
                var options = defn['values'].slice(0);
                options.unshift([null, '- All -']);
                set_options(widget, _.map(options, function(val) {
                    return {
                        'value': val[0],
                        'text': val[1]
                    }
                }));
                widget.on('change', function() {
                    configure_unselected_contextual_filters();
                });
            });
            update_contextual_controls();
        });
    };

    var marshal_amplicon_filter = function() {
        return {
          'value': $('#amplicon').val(),
          'operator': $('#amplicon_op').val()
        };
    };

    var marshal_environment_filter = function() {
        var value = $('#environment').val();
        if (!value) {
          return null;
        }
        return {
          'value': $('#environment').val(),
          'operator': $('#environment_op').val()
        };
    };

    var marshal_contextual_filters = function() {
        var filter_state = _.map($("#contextual_filters_target > div"), function(target) {
            var marshal_input = function(selector, obj_name) {
                var matches = $(selector, target);
                if (matches.length == 1) {
                    var val = matches.val();
                    if (!val) {
                        obj['invalid'] = true;
                    } else {
                        obj[obj_name] = val;
                    }
                }
            }
            var obj = {};
            obj['field'] = $(".contextual-item", target).val();
            marshal_input('.cval_op', 'operator');
            marshal_input('.cval_from', 'from');
            marshal_input('.cval_to', 'to');
            marshal_input('.cval_contains', 'contains');
            marshal_input('.cval_select', 'is');
            return obj;
        });
        filter_state = _.filter(filter_state, function(o) {
            return !o.invalid;
        });
        return {
            'filters': filter_state,
            'environment': marshal_environment_filter(),
            'mode': $('#contextual_filters_mode').val()
        };
    };

    var marshal_taxonomy_filters = function() {
        return taxonomy_get_state();
    };

    var search_complete = function() {
        spinner.stop();
    };

    var setup_search = function() {
        $("#search_button").click(function() {
            spinner.start();
            datatable.ajax.reload(search_complete);
        });
    };

    var setup_csrf = function() {
        var csrftoken = jQuery("[name=csrfmiddlewaretoken]").val();
        function csrfSafeMethod(method) {
            // these HTTP methods do not require CSRF protection
            return (/^(GET|HEAD|OPTIONS|TRACE)$/.test(method));
        }
        $.ajaxSetup({
            beforeSend: function(xhr, settings) {
                if (!csrfSafeMethod(settings.type) && !this.crossDomain) {
                    xhr.setRequestHeader("X-CSRFToken", csrftoken);
                }
            }
        });
    };

    var describe_search = function() {
        return {
            'taxonomy_filters': marshal_taxonomy_filters(),
            'contextual_filters': marshal_contextual_filters(),
            'amplicon_filter': marshal_amplicon_filter(),
        };
    }

    var set_search_data = function(data, settings) {
        $.when(check_for_auth_token()).done(function() {
            data['otu_query'] = JSON.stringify(describe_search());
            data['token'] = authentication_token;

            return data;
        });
    };

    var set_errors = function(errors) {
        var target = $("#error-box");
        target.empty();
        if (!errors) {
            target.hide();
            return;
        }
        target.show();
        target.append($("<h3>Error:</h3>"));
        var ul = $("<ul></ul>");
        target.append(ul);
        $.each(errors, function(i, e) {
            ul.append($("<li>").text(e));
        });
    }

    var setup_datatables = function() {
        $.when(check_for_auth_token()).done(function() {
            datatable = $("#results").DataTable({
                'processing': true,
                'serverSide': true,
                'ajax': {
                    'url': window.otu_search_config['search_endpoint'],
                    'type': 'POST',
                    'data': set_search_data
                },
                columns: [
                  {
                      'data': 'bpa_id',
                      'defaultContent': '',
                      'render': function(data, type, row) {
                          var org = 'australian-microbiome';
                          var url = window.otu_search_config['ckan_base_url'] + '/organization/' + org + '?q=bpa_id:102.100.100.' + data;
                          return '<a href="' + url + '" target="_blank">' + data + '</a>';
                      }
                  },
                  {
                      'data': 'environment',
                      'defaultContent': ''
                  }
                ]
            });
            $("#results").on('xhr.dt', function(e, settings, json, xhr) {
                if (json) {
                    set_errors(json.errors);
                }
            });
        });
    };

    var setup_export = function() {
        $.when(check_for_auth_token()).done(function() {
            var target = $("#export_button");
            target.click(function() {
                var params = {
                    'token': authentication_token,
                    'q': JSON.stringify(describe_search())
                }
                var target_url = window.otu_search_config['export_endpoint'] + '?' + $.param(params);
                window.open(target_url);
            });
        });
    };

    var setup_galaxy = function() {
        var galaxyLoading = $('#galaxy-loading');
        var allAlertTypes = _.join(_.map(_.split(
          'primary secondary success danger warning info light dark', ' '),
          function(n) { return 'alert-' + n; }), ' ');

        function displayMsg(txt, type) {
            type = type || 'alert-success';
            var alert = $('#search-alert');
            alert.find('.text').text(txt);
            alert.removeClass(allAlertTypes).addClass(type);
            alert.show();
            alert.alert();
            if (!_.includes(['alert-warning', 'alert-danger'], type)) {
                setTimeout(function() {alert.hide()}, 3000);
            }
        }

        $.when(check_for_auth_token()).done(function() {
            var target = $("#submit_galaxy_button");
            target.click(function() {
                target.attr('disabled', 'disabled');
                galaxyLoading.show();
                var data = {
                    'token': authentication_token,
                    // TODO which workflow
                    // 'q': JSON.stringify(describe_search())
                }

              var handleError = function(errMsg) {
                  var msg = 'Error in submitting Galaxy workflow!';
                  console.error(msg);
                  if (errMsg) {
                      console.error('    ', errMsg);
                  }
                  displayMsg(msg, 'alert-danger');
                  galaxyLoading.hide();
                  target.removeAttr('disabled');
              }

              $.ajax({
                  url: window.otu_search_config['submit_to_galaxy_endpoint'],
                  method: 'POST',
                  data: data,
                  success: function(result) {
                    if (!result.success) {
                        handleError(result.errors);
                        return;
                    }
                    displayMsg('Submitted to Galaxy');
                    galaxyLoading.hide();
                    target.removeAttr('disabled');
                  },
                  error: function(resp) {
                    handleError(resp.responseText || resp);
                  }
             });
            });
        });
    };

    var get_sample_sites = function(samplesMap) {
        var info = $('#sample-sites-info');
        info.text('Processing...');
        modalSpinner.start();
        $.when(check_for_auth_token()).done(function() {
            var data = {
                'token': authentication_token,
                'otu_query': JSON.stringify(describe_search())
            }

            $.ajax({
                url: window.otu_search_config['search_sample_sites_endpoint'],
                method: 'POST',
                data: data,
                success: function(result) {
                    var markers = L.markerClusterGroup();
                    _.each(result.data, function(sample) {
                        var title = sample.bpa_id + ' [' + sample.latitude + ', ' + sample.longitude + ']';
                        var marker = L.marker([sample.latitude, sample.longitude],
                                              {title: title, riseOnHover: true});
                        markers.addLayer(marker);
                    });
                    samplesMap.addLayer(markers);

                    info.text('Showing ' + result.data.length + ' samples');
                    modalSpinner.stop();
                }
            });
        });
    }

    var setup_map = function() {
        var modal = $('#map-modal');

        var removePreviousMap = function() {
            _.each(window.maps, function(map) {
                map.off();
                map.remove();
            });
           window.maps = [];
        };

        var displayMap = function() {
          loadmapsamples_map();
          get_sample_sites(window.maps[0]);
        };

        modal.on('shown.bs.modal', function() {
          displayMap();
        });
        modal.on('hidden.bs.modal', function() {
          removePreviousMap();
        });

        $("#show_map_button").click(function() {
           modal.modal('show');
        });
    };

    function check_for_auth_token() {
        if (! window.otu_search_config['ckan_auth_integration']) {
            return;
        } else if (authentication_token == null) {
            get_auth_token();
        }
        return;
    }

    function run_setup_functions() {
        setup_csrf();
        setup_amplicon();
        setup_taxonomic();
        setup_contextual();
        setup_search();
        setup_datatables();
        setup_map();
        setup_galaxy();
        setup_export();
        set_errors(null);

        $(document).tooltip();
    }

    function get_auth_token() {
        if (! window.otu_search_config['ckan_auth_integration']) {
            run_setup_functions();
            return;
        }

        var bpa_endpoint = '/user/private/api/bpa/check_permissions';

        $.ajax({
            url: bpa_endpoint,
            async: true,
            success: function(result) {
                authentication_token = result;

                run_setup_functions();

                var data_portion = $.parseJSON(authentication_token.split("||")[1]);
                $("#user_id").append(data_portion.email + " | " + '<a href="/user/_logout">Sign Out</a>');

                $("#token_error_message").hide();

            },
            error: function(result) {
                $("#token_error_message").html("<span class='error_text bg-warning'>\
                                                <b>Login required: </b>Please log into the <a href='/user/login'>Bioplatforms Data Portal</a>, \
                                                or <a href='/user/register'>request access</a>. \
                                                If you still cannot access the data after logging in, contact <a href='help@bioplatforms.com'>support</a>.</span>").toggle();
            }
        });
    }

    get_auth_token();
});
